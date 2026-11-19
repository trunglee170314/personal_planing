import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import type {
  TimelineHierarchyPlan,
  TimelineWorkspace,
} from '../lib/data/repository';

const origin = 'http://127.0.0.1:3000',
  token = 'hierarchy-test-only';
let child: ChildProcess | undefined,
  directory = '',
  url = '',
  goal = '',
  source = '',
  descendant = '',
  target = '';
const headers = (extra: Record<string, string> = {}) => ({
  origin,
  'content-type': 'application/json',
  'x-myplan-local': '1',
  'x-myplan-local-token': token,
  ...extra,
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

describe('Timeline hierarchy isolated HTTP API', () => {
  beforeAll(async () => {
    const port = await freePort();
    directory = mkdtempSync(join(tmpdir(), 'myplan-hierarchy-api-'));
    const path = join(directory, 'test.db'),
      db = new LocalDatabase(path);
    try {
      goal = db.createGoal({ title: 'Hierarchy API Goal' });
      source = db.createTask({
        title: 'Source',
        goal_id: goal,
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      descendant = db.createTask({
        title: 'Descendant',
        goal_id: goal,
        parent_task_id: source,
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      target = db.createTask({
        title: 'Target',
        goal_id: goal,
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
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
          MYPLAN_LOCAL_DB_PATH: path,
          MYPLAN_BACKUP_DIR: join(directory, 'backups'),
          MYPLAN_LOCAL_TOKEN: token,
          MYPLAN_LOCAL_APP_ORIGINS: origin,
        },
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) return;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Hierarchy test API did not become ready');
  });
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((done) => child!.once('exit', () => done()));
    }
    if (directory) {
      const path = resolve(directory);
      if (
        dirname(path) !== resolve(tmpdir()) ||
        !basename(path).startsWith('myplan-hierarchy-api-')
      )
        throw new Error('Unexpected test cleanup path');
      rmSync(path, { recursive: true, force: true });
    }
  });
  async function preview() {
    const response = await fetch(`${url}/api/timeline/hierarchy/${source}`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: TimelineHierarchyPlan }).data;
  }
  async function workspace() {
    const response = await fetch(`${url}/api/timeline`, { headers: headers() });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: TimelineWorkspace }).data;
  }
  it('routes preview and atomic subtree restructure with one HTTP Undo receipt', async () => {
    const plan = await preview();
    expect(plan.tree).toHaveLength(3);
    expect(plan.tree.find((row) => row.id === descendant)?.parent_task_id).toBe(
      source,
    );
    const operation = '00000000-0000-4000-8000-000000000141',
      session = '00000000-0000-4000-8000-000000000142';
    const response = await fetch(`${url}/api/timeline/hierarchy`, {
      method: 'PUT',
      headers: headers({
        'x-myplan-undo-operation': operation,
        'x-myplan-undo-session': session,
      }),
      body: JSON.stringify({
        task_id: source,
        target_kind: 'task',
        target_id: target,
        placement: 'inside',
        expected_version: plan.version,
      }),
    });
    expect(response.status).toBe(200);
    let next = await workspace();
    expect(next.tasks.find((row) => row.id === source)?.parent_task_id).toBe(
      target,
    );
    expect(
      next.tasks.find((row) => row.id === descendant)?.parent_task_id,
    ).toBe(source);
    const undo = await fetch(`${url}/api/undo`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ operation, session }),
    });
    expect(undo.status).toBe(200);
    next = await workspace();
    expect(
      next.tasks.find((row) => row.id === source)?.parent_task_id,
    ).toBeNull();
    expect(
      next.tasks.find((row) => row.id === descendant)?.parent_task_id,
    ).toBe(source);
  });
  it('rejects a stale request without overwriting a later Task edit', async () => {
    const plan = await preview();
    const edit = await fetch(`${url}/api/tasks/${target}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ title: 'Keep newer title' }),
    });
    expect(edit.status).toBe(200);
    const response = await fetch(`${url}/api/timeline/hierarchy`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        task_id: source,
        target_kind: 'task',
        target_id: target,
        placement: 'inside',
        expected_version: plan.version,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/changed/),
    });
    const next = await workspace();
    expect(
      next.tasks.find((row) => row.id === source)?.parent_task_id,
    ).toBeNull();
    expect(next.tasks.find((row) => row.id === target)?.title).toBe(
      'Keep newer title',
    );
  });
  it('keeps both new routes protected by the per-launch token', async () => {
    const read = await fetch(`${url}/api/timeline/hierarchy/${source}`, {
      headers: { origin, 'x-myplan-local': '1' },
    });
    expect(read.status).toBe(403);
    const write = await fetch(`${url}/api/timeline/hierarchy`, {
      method: 'PUT',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-myplan-local': '1',
      },
      body: '{}',
    });
    expect(write.status).toBe(403);
  });
});
