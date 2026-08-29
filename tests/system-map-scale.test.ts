import { randomUUID } from 'node:crypto';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import {
  MAP_LIMITS,
  mapDocumentBytes,
  validateMapDocument,
} from '../lib/system-map/schema.mjs';
import { scaleMap } from './fixtures/system-map-scale.mjs';
import {
  moveNodes,
  nodesInArea,
  copyCluster,
} from '../lib/system-map/commands';
import { arrangeMap, type MapDocument } from '../lib/system-map/model';
import {
  arrangeBranch,
  materializeSizes,
  searchNodes,
  snapNodeMove,
  connectionPath,
} from '../lib/system-map/geometry';

function measure(run: () => unknown, samples = 12) {
  run();
  run();
  const values = Array.from({ length: samples }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return {
    p50Ms: +values[Math.floor(values.length / 2)].toFixed(2),
    p95Ms: +values[Math.ceil(values.length * 0.95) - 1].toFixed(2),
  };
}

// Opt-in: regular CI remains fast and production limits are never modified.
it.skipIf(process.env.MYPLAN_SCALE_BENCHMARK !== '1')(
  'benchmarks isolated large maps without changing production caps',
  () => {
    const defaults = { ...MAP_LIMITS };
    const report: { [key: string]: unknown } = {
      node: process.version,
      cpu: cpus()[0]?.model,
      mode: 'Node CPU + disposable SQLite; not browser/network latency',
      productionLimits: defaults,
      experimentalLimits: { nodes: 1000, edges: 3000, bytes: 4 * 1024 * 1024 },
      cases: [],
    };
    const cases: unknown[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'myplan-scale-'));
    report.testDirectory = directory;
    try {
      expect(() => validateMapDocument(scaleMap(MAP_LIMITS.nodes + 1))).toThrow(
        /Too many/,
      );
      Object.assign(MAP_LIMITS, report.experimentalLimits);
      for (const count of [200, 500, 1000]) {
        const doc = scaleMap(count) as MapDocument;
        validateMapDocument(doc);
        const byId = new Map(doc.nodes.map((n) => [n.id, n]));
        const pipeline = (selected: number) => {
          const ids = doc.nodes.slice(0, selected).map((n) => n.id);
          const snapped = snapNodeMove(doc, ids, 15, 10, 6);
          return structuredClone(
            materializeSizes(
              moveNodes(doc, ids, snapped.dx, snapped.dy),
              (s) => s.length * 8,
            ),
          );
        };
        const metrics = {
          validate: measure(() => validateMapDocument(doc)),
          clone: measure(() => structuredClone(doc)),
          jsonEncode: measure(() => JSON.stringify(doc)),
          search: measure(() => searchNodes(doc, 'topic 0001')),
          areaSelection: measure(() =>
            nodesInArea(doc, { x: 0, y: 0 }, { x: 16000, y: 4000 }),
          ),
          dragPipeline1: measure(() => pipeline(1)),
          dragPipeline10: measure(() => pipeline(10)),
          dragPipeline100: measure(() => pipeline(100), 6),
          dragPipelineHalf: measure(() => pipeline(Math.floor(count / 2)), 6),
          copyAll: measure(() =>
            copyCluster(
              doc,
              doc.nodes.map((n) => n.id),
            ),
          ),
          curveGeometry: measure(() =>
            doc.edges.map((e) =>
              connectionPath(byId.get(e.source)!, byId.get(e.target)!),
            ),
          ),
        };
        const databasePath = join(directory, `${count}.db`),
          db = new LocalDatabase(databasePath);
        let map = db.maps.command({
          id: randomUUID(),
          action: 'create',
          expected_version: 0,
          document: doc,
        });
        const changed = moveNodes(doc, [doc.nodes[0].id], 30, 20);
        const saveTiming = measure(() => {
          map = db.maps.command({
            id: map.id,
            action: 'save',
            expected_version: map.version,
            document: changed,
            label: 'Edit node',
          });
        }, 10);
        const restoreTiming = measure(() => {
          map = db.maps.command({
            id: map.id,
            action: 'restore_revision',
            expected_version: map.version,
            revision: 1,
          });
        }, 5);
        expect(map.document).toEqual(doc);
        expect(() =>
          db.maps.command({
            id: map.id,
            action: 'save',
            expected_version: 1,
            document: doc,
          }),
        ).toThrow(/another tab/);
        const before = map.document;
        map = db.maps.command({
          id: map.id,
          action: 'save',
          expected_version: map.version,
          document: changed,
          label: 'Edit node',
        });
        map = db.maps.command({
          id: map.id,
          action: 'save',
          expected_version: map.version,
          document: before,
          label: 'Undo: Edit node',
        });
        expect(map.document).toEqual(doc);
        map = db.maps.command({
          id: map.id,
          action: 'save',
          expected_version: map.version,
          document: changed,
          label: 'Redo: Edit node',
        });
        expect(map.document).toEqual(changed);
        for (let i = 0; i < 55; ++i)
          map = db.maps.command({
            id: map.id,
            action: 'save',
            expected_version: map.version,
            document: { ...doc, name: `History ${i}` },
            label: 'Edit map',
          });
        expect(
          db.db.prepare('select count(*) n from system_map_revisions').get()?.n,
        ).toBe(50);
        const historyBytes = db.db
          .prepare(
            'select sum(length(cast(document as blob))) n from system_map_revisions',
          )
          .get()?.n;
        db.close();
        const layouts: Record<string, unknown> = {};
        for (const kind of ['grid', 'circle', 'branch-tree', 'branch-star']) {
          const start = performance.now();
          try {
            const next =
              kind === 'grid' || kind === 'circle'
                ? arrangeMap(doc, kind)
                : (() => {
                    const branch = scaleMap(
                      count,
                      240,
                      kind === 'branch-tree' ? 'tree' : 'star',
                    ) as MapDocument;
                    return arrangeBranch(branch, branch.nodes[0].id);
                  })();
            validateMapDocument(next);
            layouts[kind] = {
              ok: true,
              ms: +(performance.now() - start).toFixed(2),
            };
          } catch (error) {
            layouts[kind] = {
              ok: false,
              ms: +(performance.now() - start).toFixed(2),
              error: (error as Error).message,
            };
          }
        }
        cases.push({
          nodes: count,
          edges: doc.edges.length,
          jsonBytes: Buffer.byteLength(JSON.stringify(doc)),
          postgresJsonbBytes: mapDocumentBytes(doc),
          metrics,
          sqlite: {
            save: saveTiming,
            restore: restoreTiming,
            historyRows: 50,
            historyBytes,
            databaseBytes: statSync(databasePath).size,
          },
          layouts,
        });
      }
      const payloads = [0, 240, 1000, 4000].map((chars) => ({
        descriptionCharsPerNode: chars,
        bytes: mapDocumentBytes(scaleMap(1000, chars)),
      }));
      report.cases = cases;
      report.payloads = payloads;
      console.log(JSON.stringify(report, null, 2));
      if (process.env.MYPLAN_BENCHMARK_OUTPUT)
        writeFileSync(
          process.env.MYPLAN_BENCHMARK_OUTPUT,
          JSON.stringify(report, null, 2),
        );
    } finally {
      Object.assign(MAP_LIMITS, defaults);
    }
    expect(MAP_LIMITS).toEqual(defaults);
  },
  120000,
);
