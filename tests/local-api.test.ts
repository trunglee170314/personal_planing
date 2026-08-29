import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const allowedOrigin = 'http://localhost:3000';
const token = 'test-local-api-token';
let child: ChildProcess;
let directory: string;
let apiUrl: string;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Unable to reserve a local API test port.');
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  return address.port;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${apiUrl}/health`)).ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Local API did not become healthy during the test.');
}

function headers(overrides: Record<string, string> = {}) {
  return {
    origin: allowedOrigin,
    'content-type': 'application/json',
    'x-myplan-local': '1',
    'x-myplan-local-token': token,
    ...overrides,
  };
}

describe('local SQLite HTTP API', () => {
  beforeAll(async () => {
    const port = await availablePort();
    directory = mkdtempSync(join(tmpdir(), 'myplan-api-'));
    apiUrl = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', resolve('local-server/server.mjs')],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          MYPLAN_LOCAL_API_PORT: String(port),
          MYPLAN_LOCAL_DB_PATH: join(directory, 'myplan.db'),
          MYPLAN_BACKUP_DIR: join(directory, 'backups'),
          MYPLAN_LOCAL_TOKEN: token,
        },
        stdio: 'ignore',
      },
    );
    await waitForHealth();
  });

  afterAll(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolvePromise) =>
        child.once('exit', () => resolvePromise()),
      );
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists authorized CRUD requests', async () => {
    const createResponse = await fetch(`${apiUrl}/api/goals`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        title: 'HTTP goal',
        description: null,
        ends_on: null,
      }),
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await fetch(`${apiUrl}/api/goals`, {
      headers: headers(),
    });
    expect(listResponse.status).toBe(200);
    const payload = (await listResponse.json()) as {
      data: { title: string }[];
    };
    expect(payload.data).toEqual([
      expect.objectContaining({ title: 'HTTP goal' }),
    ]);

    const goalId = (
      (await (
        await fetch(`${apiUrl}/api/goals`, { headers: headers() })
      ).json()) as { data: { id: string }[] }
    ).data[0].id;
    const editResponse = await fetch(`${apiUrl}/api/goals/${goalId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ title: 'Edited HTTP goal' }),
    });
    expect(editResponse.status).toBe(200);
    const trashResponse = await fetch(`${apiUrl}/api/goals/${goalId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    });
    expect(trashResponse.status).toBe(200);
    const trashPayload = (await (
      await fetch(`${apiUrl}/api/goals?view=trash`, { headers: headers() })
    ).json()) as { data: { title: string }[] };
    expect(trashPayload.data[0].title).toBe('Edited HTTP goal');
    const deleteResponse = await fetch(`${apiUrl}/api/goals/${goalId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(deleteResponse.status).toBe(200);
    expect(
      (
        (await (
          await fetch(`${apiUrl}/api/goals?view=trash`, { headers: headers() })
        ).json()) as { data: unknown[] }
      ).data,
    ).toEqual([]);

    const workspace = (await (
      await fetch(`${apiUrl}/api/tasks/workspace`, { headers: headers() })
    ).json()) as { data: { statuses: { id: string; category: string }[] } };
    const plannedId = workspace.data.statuses.find(
      (status) => status.category === 'planned',
    )?.id;
    expect(plannedId).toBeTruthy();
    const taskResponse = await fetch(`${apiUrl}/api/tasks`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        title: 'HTTP task',
        priority: 'medium',
        due_at: null,
        workflow_status_id: plannedId,
      }),
    });
    expect(taskResponse.status).toBe(201);
    const taskId = ((await taskResponse.json()) as { data: string }).data;
    expect(
      (
        await fetch(`${apiUrl}/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({
            title: 'Edited HTTP task',
            archived_at: new Date().toISOString(),
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (
          await fetch(`${apiUrl}/api/tasks/workspace?view=archived`, {
            headers: headers(),
          })
        ).json()) as { data: { tasks: { title: string }[] } }
      ).data.tasks[0].title,
    ).toBe('Edited HTTP task');
    expect(
      (
        await fetch(`${apiUrl}/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ deleted_at: new Date().toISOString() }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (
          await fetch(`${apiUrl}/api/tasks/workspace?view=trash`, {
            headers: headers(),
          })
        ).json()) as { data: { tasks: { id: string }[] } }
      ).data.tasks[0].id,
    ).toBe(taskId);
    expect(
      (
        await fetch(`${apiUrl}/api/tasks/${taskId}`, {
          method: 'DELETE',
          headers: headers(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (
          await fetch(`${apiUrl}/api/tasks/workspace?view=trash`, {
            headers: headers(),
          })
        ).json()) as { data: { tasks: unknown[] } }
      ).data.tasks,
    ).toEqual([]);
  });

  it('synchronizes linked Goal progress through the HTTP API', async () => {
    await fetch(`${apiUrl}/api/goals`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        title: 'Automatic HTTP goal',
        description: null,
        ends_on: null,
      }),
    });
    const goals = (await (
      await fetch(`${apiUrl}/api/goals`, { headers: headers() })
    ).json()) as {
      data: { id: string; title: string; progress: number; status: string }[];
    };
    const goalId = goals.data.find(
      (goal) => goal.title === 'Automatic HTTP goal',
    )?.id;
    expect(goalId).toBeTruthy();

    const workspace = (await (
      await fetch(`${apiUrl}/api/tasks/workspace`, { headers: headers() })
    ).json()) as { data: { statuses: { id: string; category: string }[] } };
    const plannedId = workspace.data.statuses.find(
      (status) => status.category === 'planned',
    )?.id;
    const completedId = workspace.data.statuses.find(
      (status) => status.category === 'completed',
    )?.id;
    const taskResponse = await fetch(`${apiUrl}/api/tasks`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        title: 'Automatic HTTP task',
        priority: 'medium',
        due_at: null,
        workflow_status_id: plannedId,
        goal_id: goalId,
      }),
    });
    const taskId = ((await taskResponse.json()) as { data: string }).data;

    await fetch(`${apiUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        workflow_status_id: completedId,
        completed_at: new Date().toISOString(),
        progress: 100,
      }),
    });
    const completedGoal = (
      (await (
        await fetch(`${apiUrl}/api/goals`, { headers: headers() })
      ).json()) as { data: { id: string; progress: number; status: string }[] }
    ).data.find((goal) => goal.id === goalId);
    expect(completedGoal).toMatchObject({ progress: 100, status: 'completed' });

    await fetch(`${apiUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        workflow_status_id: plannedId,
        completed_at: null,
        progress: 0,
      }),
    });
    const reopenedGoal = (
      (await (
        await fetch(`${apiUrl}/api/goals`, { headers: headers() })
      ).json()) as { data: { id: string; progress: number; status: string }[] }
    ).data.find((goal) => goal.id === goalId);
    expect(reopenedGoal).toMatchObject({ progress: 0, status: 'active' });

    await fetch(`${apiUrl}/api/tasks/${taskId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    await fetch(`${apiUrl}/api/goals/${goalId}`, {
      method: 'DELETE',
      headers: headers(),
    });
  });

  it('rejects untrusted origins and incorrect startup tokens', async () => {
    const wrongOrigin = await fetch(`${apiUrl}/api/goals`, {
      headers: headers({ origin: 'http://localhost:3001' }),
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongToken = await fetch(`${apiUrl}/api/goals`, {
      headers: headers({ 'x-myplan-local-token': 'wrong' }),
    });
    expect(wrongToken.status).toBe(403);
  });
});
