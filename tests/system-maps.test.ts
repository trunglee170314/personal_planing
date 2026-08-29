import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { backupDatabase, verifyBackup } from '../local-server/backup.mjs';
import { backupConfig } from '../local-server/local-paths.mjs';
import { validateMapDocument } from '../lib/system-map/schema.mjs';
import {
  arrangeMap,
  emptyMap,
  moveGroup,
  removeGroup,
  removeNode,
  resizeGroup,
  type MapDocument,
  type MapNode,
  type SystemMap,
} from '../lib/system-map/model';

const node = (group_id: string | null = null, x = 100, y = 140): MapNode => ({
  id: randomUUID(),
  name: 'Node',
  description: '',
  url: '',
  color: '#28745b',
  group_id,
  x,
  y,
});
describe('System Maps', () => {
  let database: LocalDatabase;
  beforeEach(() => {
    database = new LocalDatabase(':memory:');
  });
  afterEach(() => database.close());
  const create = (): SystemMap =>
    database.maps.command({
      action: 'create',
      id: randomUUID(),
      expected_version: 0,
      document: emptyMap('My system'),
    });
  const save = (
    map: SystemMap,
    document: MapDocument,
    label = 'Edit map',
  ): SystemMap =>
    database.maps.command({
      action: 'save',
      id: map.id,
      expected_version: map.version,
      document,
      label,
    });
  it('rejects stale writes without modifying either map or history', () => {
    const first = create(),
      changed = save(first, { ...first.document, name: 'Changed' });
    expect(() =>
      save(first, { ...first.document, name: 'Lost update' }),
    ).toThrow(/another tab/);
    expect(database.maps.get(first.id)).toEqual(changed);
    expect(
      database.maps
        .history(first.id)
        .map((row: { version: number }) => row.version),
    ).toEqual([2, 1]);
  });
  it('restores a complete snapshot as a new version and retains the version replaced', () => {
    const first = create(),
      second = save(first, { ...first.document, nodes: [node()] });
    const restored = database.maps.command({
      action: 'restore_revision',
      id: first.id,
      expected_version: second.version,
      revision: 1,
    });
    expect(restored.document.nodes).toHaveLength(0);
    expect(restored.version).toBe(3);
    expect(database.maps.history(first.id)).toHaveLength(3);
    expect(() =>
      database.maps.command({
        action: 'restore_revision',
        id: first.id,
        expected_version: 3,
        revision: 404,
      }),
    ).toThrow(/not found/);
    expect(database.maps.get(first.id).version).toBe(3);
  });
  it('coalesces layout moves while preserving the snapshot before the first move', () => {
    const first = create(),
      second = save(
        first,
        { ...first.document, nodes: [node()] },
        'Move layout',
      );
    const third = save(
      second,
      {
        ...second.document,
        nodes: second.document.nodes.map((n) => ({ ...n, x: n.x + 10 })),
      },
      'Move layout',
    );
    expect(
      database.maps
        .history(first.id)
        .map((row: { version: number }) => row.version),
    ).toEqual([3, 1]);
    expect(database.maps.get(first.id).document).toEqual(third.document);
  });
  it('bounds history without removing the latest snapshot', () => {
    let map = create();
    for (let i = 0; i < 60; i++)
      map = save(map, { ...map.document, name: `Change ${i}` });
    expect(
      database.db
        .prepare('SELECT count(*) n FROM system_map_revisions WHERE map_id=?')
        .get(map.id)?.n,
    ).toBe(50);
    expect(database.maps.history(map.id)[0].version).toBe(61);
    expect(database.maps.history(map.id, 40)).toHaveLength(10);
  });
  it('keeps Trash history, blocks edits in Trash, restores and cascades permanent deletion', () => {
    const first = create(),
      deleted = database.maps.command({
        action: 'trash',
        id: first.id,
        expected_version: 1,
      });
    expect(database.maps.list()).toHaveLength(0);
    expect(database.maps.list(true)).toHaveLength(1);
    expect(() => save(deleted, deleted.document)).toThrow(/Restore/);
    const restored = database.maps.command({
      action: 'restore',
      id: first.id,
      expected_version: 2,
    });
    expect(restored.version).toBe(3);
    expect(() =>
      database.maps.command({
        action: 'purge',
        id: first.id,
        expected_version: 3,
      }),
    ).toThrow(/Trash first/);
    database.maps.command({
      action: 'trash',
      id: first.id,
      expected_version: 3,
    });
    database.maps.command({
      action: 'purge',
      id: first.id,
      expected_version: 4,
    });
    expect(
      database.db.prepare('SELECT count(*) n FROM system_map_revisions').get()
        ?.n,
    ).toBe(0);
  });
  it('expires only maps older than the 30-day Trash window', () => {
    const first = create(),
      second = create();
    database.maps.command({
      action: 'trash',
      id: first.id,
      expected_version: 1,
    });
    database.db
      .prepare('UPDATE system_maps SET deleted_at=? WHERE id=?')
      .run(new Date(Date.now() - 31 * 86400000).toISOString(), first.id);
    expect(database.maps.list().map((item: { id: string }) => item.id)).toEqual(
      [second.id],
    );
    expect(database.maps.list(true)).toHaveLength(0);
  });
  it('rolls invalid documents back atomically and rejects unsafe links and orphan edges', () => {
    const map = create();
    const n = node();
    n.url = 'javascript:alert(1)';
    expect(() => save(map, { ...map.document, nodes: [n] })).toThrow(/http/);
    expect(() =>
      save(map, {
        ...map.document,
        edges: [
          {
            id: randomUUID(),
            source: randomUUID(),
            target: randomUUID(),
            line: 'solid',
            direction: 'both',
          },
        ],
      }),
    ).toThrow(/existing nodes/);
    expect(() =>
      save(map, { ...map.document, nodes: [{ ...node(), x: Infinity }] }),
    ).toThrow(/coordinates/);
    expect(database.maps.get(map.id).version).toBe(1);
    expect(database.maps.history(map.id)).toHaveLength(1);
  });
  it('deleting nodes cascades edges; deleting groups detaches nodes without losing edges', () => {
    const group = {
      id: randomUUID(),
      name: 'Group',
      color: '#28745b',
      x: 40,
      y: 60,
      width: 500,
      height: 300,
      collapsed: false,
    };
    const a = node(group.id),
      b = node(null, 700, 140),
      doc = {
        ...emptyMap('Relations'),
        groups: [group],
        nodes: [a, b],
        edges: [
          {
            id: randomUUID(),
            source: a.id,
            target: b.id,
            line: 'dashed' as const,
            direction: 'both' as const,
          },
        ],
      };
    const detached = removeGroup(doc, group.id);
    expect(detached.nodes[0].group_id).toBeNull();
    expect(detached.edges).toHaveLength(1);
    expect(removeNode(doc, a.id).edges).toHaveLength(0);
    validateMapDocument(detached);
    expect(() =>
      validateMapDocument({
        ...doc,
        edges: [
          ...doc.edges,
          { ...doc.edges[0], id: randomUUID(), source: b.id, target: a.id },
        ],
      }),
    ).toThrow(/already connected/);
  });
  it('group moves shift only members and resizing cannot exclude them', () => {
    const group = {
      id: randomUUID(),
      name: 'Group',
      color: '#28745b',
      x: 40,
      y: 60,
      width: 500,
      height: 300,
      collapsed: false,
    };
    const doc = {
      ...emptyMap('Layout'),
      groups: [group],
      nodes: [node(group.id), node(null, 800, 400)],
    };
    const moved = moveGroup(doc, group.id, 50, -20);
    expect(moved.nodes[0].x).toBe(150);
    expect(moved.nodes[1].x).toBe(800);
    validateMapDocument(moved);
    const resized = resizeGroup(doc, group.id, {
      x: 200,
      y: 200,
      width: 220,
      height: 130,
    });
    validateMapDocument(resized);
    expect(resized.groups[0].x).toBeLessThanOrEqual(doc.nodes[0].x);
    for (const layout of ['grid', 'circle'] as const)
      validateMapDocument(arrangeMap(doc, layout));
  });
  it('persists maps and enforces CAS across separate SQLite connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'the-plan-map-')),
      path = join(directory, 'maps.db');
    const first = new LocalDatabase(path),
      second = new LocalDatabase(path);
    try {
      const original = first.maps.command({
        action: 'create',
        id: randomUUID(),
        expected_version: 0,
        document: emptyMap('Persistent'),
      });
      const stale = second.maps.get(original.id);
      first.maps.command({
        action: 'save',
        id: original.id,
        expected_version: 1,
        document: { ...original.document, nodes: [node()] },
      });
      expect(() =>
        second.maps.command({
          action: 'save',
          id: stale.id,
          expected_version: stale.version,
          document: stale.document,
        }),
      ).toThrow(/another tab/);
      expect(second.maps.get(original.id).document.nodes).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('includes map documents and their history in a live SQLite backup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'the-plan-map-backup-'));
    const config = backupConfig({
      ...process.env,
      MYPLAN_LOCAL_DB_PATH: join(directory, 'maps.db'),
      MYPLAN_BACKUP_DIR: join(directory, 'backups'),
    });
    const source = new LocalDatabase(config.databasePath);
    try {
      const original = source.maps.command({
        action: 'create',
        id: randomUUID(),
        expected_version: 0,
        document: emptyMap('Backup map'),
      });
      const saved = source.maps.command({
        action: 'save',
        id: original.id,
        expected_version: 1,
        document: { ...original.document, nodes: [node()] },
      });
      const snapshot = backupDatabase(config);
      if (!snapshot) throw new Error('Manual backup was not created');
      expect(verifyBackup(snapshot.file)).toBe(true);
      const restored = new LocalDatabase(snapshot.file);
      try {
        expect(restored.maps.get(original.id)).toEqual(saved);
        expect(restored.maps.history(original.id)).toEqual(
          source.maps.history(original.id),
        );
      } finally {
        restored.close();
      }
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
