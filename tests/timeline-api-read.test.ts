import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import type { TimelineWorkspace } from '../lib/data/repository';

const origin = 'http://127.0.0.1:3000';
const token = 'timeline-api-test-only';
let child: ChildProcess | undefined;
let directory = '';
let url = '';
let taskId = '';
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test port.');
  const port = address.port;
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  return port;
}

describe('Timeline read options over the isolated Local HTTP API', () => {
  beforeAll(async () => {
    const port = await freePort();
    directory = mkdtempSync(join(tmpdir(), 'myplan-timeline-api-'));
    const dbPath = join(directory, 'isolated.db');
    const db = new LocalDatabase(dbPath);
    try {
      const goal = db.createGoal({ title: 'Isolated test Goal' });
      taskId = db.createTask({
        title: 'Isolated test Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
        goal_id: goal,
      });
      const checklist = db.createCalendarSession({
        title: 'Two test occurrences',
        task_id: taskId,
        item_type: 'checklist',
        starts_at: '2026-11-01T01:00:00.000Z',
        ends_at: '2026-11-01T02:00:00.000Z',
        all_day: false,
        timezone: 'Asia/Ho_Chi_Minh',
        recurrence: 'daily',
        recurrence_until: '2026-11-02',
        notification_offsets: [],
      });
      db.updateCalendarOccurrence(checklist, {
        occurrence_start: '2026-11-01T01:00:00.000Z',
        completed_at: '2026-11-01T02:00:00.000Z',
      });
    } finally {
      db.close();
    }
    url = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', resolve('local-server/server.mjs')],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          MYPLAN_LOCAL_API_PORT: String(port),
          MYPLAN_LOCAL_DB_PATH: dbPath,
          MYPLAN_BACKUP_DIR: join(directory, 'backups'),
          MYPLAN_LOCAL_TOKEN: token,
          MYPLAN_LOCAL_APP_ORIGINS: origin,
        },
        stdio: 'ignore',
      },
    );
    for (let attempt = 0; attempt < 50; ++attempt) {
      try {
        if ((await fetch(`${url}/health`)).ok) return;
      } catch {
        /* Wait for this isolated child only. */
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error('Isolated Timeline API did not become ready.');
  });
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolvePromise) =>
        child!.once('exit', () => resolvePromise()),
      );
    }
    if (directory) {
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('myplan-timeline-api-')
      )
        throw new Error('Refusing to remove an unexpected test directory.');
      rmSync(target, { recursive: true, force: true });
    }
  });
  async function read(query = '') {
    const response = await fetch(`${url}/api/timeline${query}`, {
      headers: { origin, 'x-myplan-local': '1', 'x-myplan-local-token': token },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: TimelineWorkspace }).data;
  }
  it('defaults to full counts, omits only explicitly requested counts, and restores full reads afterward', async () => {
    const full = await read();
    expect(full.tasks.find((task) => task.id === taskId)).toMatchObject({
      active_checklist_count: 2,
      checklist_resolved_count: 1,
      checklist_done_count: 1,
      progress: 50,
    });
    const lightweight = await read('?checklistCounts=0');
    expect(lightweight.tasks.find((task) => task.id === taskId)).toMatchObject({
      active_checklist_count: 0,
      progress: 50,
    });
    expect(lightweight.links).toEqual(full.links);
    expect(lightweight.goals).toEqual(full.goals);
    expect(await read('?checklistCounts=1')).toEqual(full);
    expect(await read('?checklistCounts=unexpected')).toEqual(full);
    expect(await read()).toEqual(full);
  });
  it('does not bypass Local authentication with the lightweight query parameter', async () => {
    const response = await fetch(`${url}/api/timeline?checklistCounts=0`, {
      headers: { origin, 'x-myplan-local': '1' },
    });
    expect(response.status).toBe(403);
  });
});
