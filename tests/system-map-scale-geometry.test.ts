import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { scaleMap } from './fixtures/system-map-scale.mjs';
import { MAP_LIMITS, validateMapDocument } from '../lib/system-map/schema.mjs';
import { arrangeMap, type MapDocument } from '../lib/system-map/model';
import {
  NodeObstacles,
  findOpenPoint,
  nodesInViewport,
  viewportBox,
  intersectsBox,
  connectionBounds,
  connectionPath,
  arrangeBranch,
  snapNodeMove,
  createSnapIndex,
  snapIndexedNodes,
  searchNodes,
  nodeBox,
  overlaps,
  newNodePoint,
} from '../lib/system-map/geometry';
import { moveNodes } from '../lib/system-map/commands';
it('accepts 1,000 nodes and rejects the next node without changing document', () => {
  expect(MAP_LIMITS.nodes).toBe(1000);
  validateMapDocument(scaleMap(1000));
  expect(() => validateMapDocument(scaleMap(1001))).toThrow(/Too many/);
});
it('culls by actual bounds while preserving focus independently of search matches', () => {
  const doc = scaleMap(1000) as MapDocument,
    box = viewportBox({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 500 });
  const visible = nodesInViewport(doc.nodes, box);
  expect(visible.length).toBeLessThan(30);
  expect(
    nodesInViewport(doc.nodes, box, new Set([doc.nodes[999].id])).some(
      (n) => n.id === doc.nodes[999].id,
    ),
  ).toBe(true);
  const matches = new Set(searchNodes(doc, 'Topic 0001').map((n) => n.id));
  expect(matches.size).toBe(1);
  expect(visible.filter((n) => !matches.has(n.id)).length).toBeGreaterThan(0);
  expect(searchNodes(doc, '')).toHaveLength(1000);
  const a = { ...doc.nodes[0], x: -1000, y: 20 },
    b = { ...doc.nodes[1], x: 1000, y: 20 };
  expect(
    nodesInViewport([a, b], { x: 0, y: 0, width: 100, height: 100 }),
  ).toHaveLength(0);
  expect(
    intersectsBox(connectionBounds(connectionPath(a, b)), {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }),
  ).toBe(true);
});
it('indexed placement matches linear collision checks across negative bucket boundaries', () => {
  const doc = scaleMap(200) as MapDocument;
  doc.nodes = doc.nodes.map((n, i) => ({ ...n, x: n.x - 2000, y: n.y - 500 }));
  const candidate = { ...doc.nodes[0], id: randomUUID() };
  for (const point of [
    { x: -512, y: -512 },
    { x: 500, y: 0 },
    { x: 1000, y: 200 },
  ])
    expect(
      findOpenPoint(candidate, point, new NodeObstacles(doc.nodes)),
    ).toEqual(findOpenPoint(candidate, point, doc.nodes));
});
it('reuses snap indexes and only performs coordinate checks for pointer previews', () => {
  const doc = scaleMap(1000) as MapDocument,
    ids = doc.nodes.slice(0, 100).map((n) => n.id);
  expect(
    snapIndexedNodes(doc, ids, createSnapIndex(doc, ids), 15, 10, 6),
  ).toEqual(snapNodeMove(doc, ids, 15, 10, 6));
  const preview = moveNodes(doc, ids, 10, 20, true);
  validateMapDocument(preview);
  expect(doc.nodes[0].x).toBe(0);
  expect(() => moveNodes(doc, ids, 30000, 0, true)).toThrow(/coordinates/);
});
it('lays out 1,000-node Grid/Circle and wrapped star/tree branches without overlaps or data loss', () => {
  const doc = scaleMap(1000) as MapDocument;
  for (const kind of ['grid', 'circle', 'star', 'tree']) {
    const branch = scaleMap(1000, 240, kind) as MapDocument;
    const next =
      kind === 'grid' || kind === 'circle'
        ? arrangeMap(doc, kind)
        : arrangeBranch(branch, branch.nodes[0].id);
    validateMapDocument(next);
    expect(next.nodes).toHaveLength(1000);
    const boxes = next.nodes.map(nodeBox);
    let collision = false;
    for (let i = 0; i < boxes.length; ++i)
      for (let j = i + 1; j < boxes.length; ++j)
        if (overlaps(boxes[i], boxes[j], 0)) collision = true;
    expect(collision).toBe(false);
  }
}, 15000);
it('wraps quick-created children before the vertical coordinate limit', () => {
  const doc = scaleMap(1000, 240, 'star') as MapDocument;
  const arranged = arrangeBranch(doc, doc.nodes[0].id),
    next = { ...doc.nodes[0], id: randomUUID() };
  const point = newNodePoint(
    { ...arranged, nodes: arranged.nodes.slice(0, 999) },
    next,
    arranged.nodes[0],
  );
  expect(Math.abs(point.x)).toBeLessThanOrEqual(20000);
  expect(Math.abs(point.y)).toBeLessThanOrEqual(20000);
});
