import { MAP_LIMITS, validateMapDocument } from '../lib/system-map/schema.mjs';
const now = () => new Date().toISOString();
const conflict = () => {
  const error = new Error(
    'This map changed in another tab. Reload before editing.',
  );
  error.statusCode = 409;
  throw error;
};
export class LocalSystemMaps {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS system_maps (id TEXT PRIMARY KEY,name TEXT NOT NULL,document TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS system_map_revisions (map_id TEXT NOT NULL REFERENCES system_maps(id) ON DELETE CASCADE,version INTEGER NOT NULL,document TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,changed_by TEXT NOT NULL,PRIMARY KEY(map_id,version));`);
  }
  cleanup() {
    this.db
      .prepare(
        'DELETE FROM system_maps WHERE deleted_at IS NOT NULL AND deleted_at < ?',
      )
      .run(new Date(Date.now() - 30 * 86400000).toISOString());
  }
  list(trash = false) {
    this.cleanup();
    return this.db
      .prepare(
        `SELECT id,name,version,updated_at,deleted_at FROM system_maps WHERE deleted_at IS ${trash ? 'NOT ' : ''}NULL ORDER BY updated_at DESC,id`,
      )
      .all();
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM system_maps WHERE id=?').get(id);
    if (!row) throw new Error('Map not found.');
    return { ...row, document: JSON.parse(row.document) };
  }
  history(id, offset = 0) {
    this.get(id);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAP_LIMITS.history)
      throw new Error('Invalid history page.');
    return this.db
      .prepare(
        'SELECT version,action,created_at,changed_by FROM system_map_revisions WHERE map_id=? ORDER BY version DESC LIMIT 20 OFFSET ?',
      )
      .all(id, offset);
  }
  command(input) {
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.id) ||
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 0
    )
      throw new Error('Invalid map command.');
    const { id, action } = input;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.cleanup();
      let map;
      if (action === 'create') {
        if (input.expected_version !== 0) conflict();
        if (this.db.prepare('SELECT id FROM system_maps WHERE id=?').get(id))
          conflict();
        if (
          this.db.prepare('SELECT count(*) n FROM system_maps').get().n >=
          MAP_LIMITS.maps
        )
          throw new Error('Maximum 50 maps. Empty Trash to create another.');
        const document = validateMapDocument(input.document);
        this.db
          .prepare('INSERT INTO system_maps VALUES (?,?,?,?,?,NULL)')
          .run(id, document.name.trim(), JSON.stringify(document), 1, now());
        map = this.get(id);
      } else {
        map = this.get(id);
        if (map.version !== input.expected_version) conflict();
        if (action === 'purge') {
          if (!map.deleted_at) throw new Error('Move the map to Trash first.');
          this.db.prepare('DELETE FROM system_maps WHERE id=?').run(id);
          this.db.exec('COMMIT');
          return null;
        }
        let document = map.document,
          deleted = map.deleted_at;
        if (action === 'save') {
          if (deleted) throw new Error('Restore the map before editing.');
          document = validateMapDocument(input.document);
        } else if (action === 'trash') {
          if (deleted) throw new Error('Map is already in Trash.');
          deleted = now();
        } else if (action === 'restore') {
          if (!deleted) throw new Error('Map is not in Trash.');
          deleted = null;
        } else if (action === 'restore_revision') {
          if (deleted) throw new Error('Restore the map before editing.');
          const revision = this.db
            .prepare(
              'SELECT document FROM system_map_revisions WHERE map_id=? AND version=?',
            )
            .get(id, input.revision ?? -1);
          if (!revision) throw new Error('Revision not found.');
          document = validateMapDocument(JSON.parse(revision.document));
        } else throw new Error('Invalid map action.');
        this.db
          .prepare(
            'UPDATE system_maps SET name=?,document=?,version=version+1,updated_at=?,deleted_at=? WHERE id=?',
          )
          .run(
            document.name.trim(),
            JSON.stringify(document),
            now(),
            deleted,
            id,
          );
        map = this.get(id);
      }
      if (
        input.label !== undefined &&
        (typeof input.label !== 'string' || input.label.length > 80)
      )
        throw new Error('Invalid action label.');
      const label = action === 'save' ? (input.label ?? 'Edit map') : action;
      const latest = this.db
        .prepare(
          'SELECT version,action,created_at FROM system_map_revisions WHERE map_id=? ORDER BY version DESC LIMIT 1',
        )
        .get(id);
      if (
        label === 'Move layout' &&
        latest?.action === label &&
        Date.now() - Date.parse(latest.created_at) < 300000
      )
        this.db
          .prepare(
            'DELETE FROM system_map_revisions WHERE map_id=? AND version=?',
          )
          .run(id, latest.version);
      this.db
        .prepare('INSERT INTO system_map_revisions VALUES (?,?,?,?,?,?)')
        .run(
          id,
          map.version,
          JSON.stringify(map.document),
          label,
          latest?.action === 'Move layout' &&
            label === latest.action &&
            Date.now() - Date.parse(latest.created_at) < 300000
            ? latest.created_at
            : now(),
          'local',
        );
      this.db
        .prepare(
          'DELETE FROM system_map_revisions WHERE map_id=? AND version NOT IN (SELECT version FROM system_map_revisions WHERE map_id=? ORDER BY version DESC LIMIT ?)',
        )
        .run(id, id, MAP_LIMITS.history);
      this.db.exec('COMMIT');
      return map;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
