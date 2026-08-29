import { createServer } from 'node:http';
import { loadLocalEnvironment, localDatabasePath } from './local-paths.mjs';
import { acquireDatabaseLock } from './backup.mjs';
import { startBackupScheduler } from './backup-scheduler.mjs';
import { intentionalStopCode, registerLocalControl } from './local-control.mjs';

import { LocalDatabase } from './database.mjs';
import { undoContext } from './undo.mjs';

process.umask(0o077);
loadLocalEnvironment();

const port = Number(process.env.MYPLAN_LOCAL_API_PORT || 4318);
const databasePath = localDatabasePath();
const localToken = process.env.MYPLAN_LOCAL_TOKEN;
if (!localToken)
  throw new Error(
    'MYPLAN_LOCAL_TOKEN is required. Start local mode with npm run dev:local.',
  );
const allowedOrigins = new Set(
  (
    process.env.MYPLAN_LOCAL_APP_ORIGINS ||
    'http://localhost:3000,http://127.0.0.1:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const allowedHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const releaseDatabase = acquireDatabaseLock(databasePath);
const database = new LocalDatabase(databasePath);
let stopBackups = async () => {};
let localControl;

function send(response, status, payload, origin) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(origin
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {}),
  });
  response.end(body);
}

async function readJson(request) {
  if (
    !request.headers['content-type']
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    const error = new Error(
      'Requests that change local data must use application/json.',
    );
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

const server = createServer((request, response) =>
  undoContext.run(
    {
      operation: request.headers['x-myplan-undo-operation'],
      session: request.headers['x-myplan-undo-session'],
    },
    () => handleRequest(request, response),
  ),
);
async function handleRequest(request, response) {
  const host = request.headers.host ?? '';
  const origin = request.headers.origin;
  if (!allowedHost.test(host))
    return send(response, 403, { error: 'Local API host is not allowed.' });
  if (origin && !allowedOrigins.has(origin))
    return send(response, 403, { error: 'Local API origin is not allowed.' });

  if (request.method === 'OPTIONS') {
    if (!origin) return send(response, 403, { error: 'Origin is required.' });
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers':
        'content-type,x-myplan-local,x-myplan-local-token,x-myplan-undo-operation,x-myplan-undo-session',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    return response.end();
  }

  const url = new URL(request.url ?? '/', `http://${host}`);
  // Separate filesystem-only secret, never sent to the browser app.
  if (url.pathname === '/local-control/stop' && request.method === 'POST') {
    if (
      origin ||
      !localControl ||
      request.headers['x-myplan-control'] !== localControl.token
    )
      return send(response, 403, { error: 'Local control access denied.' });
    send(response, 200, { data: 'stopping' });
    setImmediate(() => shutdown(intentionalStopCode));
    return;
  }
  if (url.pathname === '/health' && request.method === 'GET')
    return send(response, 200, { data: { status: 'ok' } }, origin);
  if (
    !origin ||
    request.headers['x-myplan-local'] !== '1' ||
    request.headers['x-myplan-local-token'] !== localToken
  )
    return send(
      response,
      403,
      {
        error:
          'This local API only accepts requests from the current local myplan app.',
      },
      origin,
    );

  try {
    if (url.pathname === '/api/undo/ready' && request.method === 'GET')
      return send(
        response,
        200,
        {
          data: database.undoReady(
            url.searchParams.get('operation'),
            url.searchParams.get('session'),
          ),
        },
        origin,
      );
    if (url.pathname === '/api/undo' && request.method === 'POST') {
      const { operation, session } = await readJson(request);
      database.applyUndo(operation, session);
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/annotations' && request.method === 'GET')
      return send(
        response,
        200,
        {
          data: database.listAnnotations({
            kind: url.searchParams.get('kind'),
            id: url.searchParams.get('id'),
          }),
        },
        origin,
      );
    if (url.pathname === '/api/annotations' && request.method === 'POST') {
      const { target, input, id } = await readJson(request);
      database.saveAnnotation(target, input, id);
      return send(response, 200, { data: null }, origin);
    }
    const annotationMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)$/);
    if (annotationMatch && request.method === 'DELETE') {
      database.deleteAnnotation(decodeURIComponent(annotationMatch[1]));
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/holidays' && request.method === 'GET')
      return send(response, 200, { data: database.listHolidays() }, origin);
    if (url.pathname === '/api/holidays' && request.method === 'POST') {
      const { input, id } = await readJson(request);
      database.saveHoliday(input, id);
      return send(response, 200, { data: null }, origin);
    }
    const holidayMatch = url.pathname.match(/^\/api\/holidays\/([^/]+)$/);
    if (holidayMatch && request.method === 'DELETE') {
      database.deleteHoliday(decodeURIComponent(holidayMatch[1]));
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/goals' && request.method === 'GET')
      return send(
        response,
        200,
        { data: database.listGoals(url.searchParams.get('view') ?? 'active') },
        origin,
      );
    if (url.pathname === '/api/goals' && request.method === 'POST') {
      const id = database.createGoal(await readJson(request));
      return send(response, 201, { data: id }, origin);
    }
    const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
    if (goalMatch && request.method === 'PATCH') {
      database.updateGoal(
        decodeURIComponent(goalMatch[1]),
        await readJson(request),
      );
      return send(response, 200, { data: null }, origin);
    }
    if (goalMatch && request.method === 'DELETE') {
      database.deleteGoal(decodeURIComponent(goalMatch[1]));
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/tasks/workspace' && request.method === 'GET')
      return send(
        response,
        200,
        {
          data: database.getTaskWorkspace(
            url.searchParams.get('view') ?? 'active',
          ),
        },
        origin,
      );
    if (url.pathname === '/api/tasks' && request.method === 'POST')
      return send(
        response,
        201,
        { data: database.createTask(await readJson(request)) },
        origin,
      );
    const taskEditMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/edit$/);
    if (taskEditMatch && request.method === 'PUT') {
      const { changes, completed } = await readJson(request);
      database.saveTaskEdit(
        decodeURIComponent(taskEditMatch[1]),
        changes,
        Boolean(completed),
      );
      return send(response, 200, { data: null }, origin);
    }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'PATCH') {
      database.updateTask(
        decodeURIComponent(taskMatch[1]),
        await readJson(request),
      );
      return send(response, 200, { data: null }, origin);
    }
    if (taskMatch && request.method === 'DELETE') {
      database.deleteTask(decodeURIComponent(taskMatch[1]));
      return send(response, 200, { data: null }, origin);
    }
    const taskCompletionMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/completion$/,
    );
    if (taskCompletionMatch && request.method === 'PUT') {
      const input = await readJson(request);
      database.setTaskCompletion(
        decodeURIComponent(taskCompletionMatch[1]),
        Boolean(input.completed),
      );
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/today' && request.method === 'GET')
      return send(
        response,
        200,
        { data: database.getTodayWorkspace() },
        origin,
      );
    if (url.pathname === '/api/calendar' && request.method === 'GET')
      return send(
        response,
        200,
        { data: database.getCalendarWorkspace() },
        origin,
      );
    if (url.pathname === '/api/calendar' && request.method === 'POST')
      return send(
        response,
        201,
        { data: database.createCalendarSession(await readJson(request)) },
        origin,
      );
    const calendarMatch = url.pathname.match(/^\/api\/calendar\/([^/]+)$/);
    if (calendarMatch && request.method === 'PATCH') {
      const { _expected, ...changes } = await readJson(request);
      database.updateCalendarSession(
        decodeURIComponent(calendarMatch[1]),
        changes,
        _expected,
      );
      return send(response, 200, { data: null }, origin);
    }
    if (calendarMatch && request.method === 'DELETE') {
      database.deleteCalendarSession(decodeURIComponent(calendarMatch[1]));
      return send(response, 200, { data: null }, origin);
    }
    const occurrenceMatch = url.pathname.match(
      /^\/api\/calendar\/([^/]+)\/occurrences$/,
    );
    if (occurrenceMatch && request.method === 'PUT') {
      database.updateCalendarOccurrence(
        decodeURIComponent(occurrenceMatch[1]),
        await readJson(request),
      );
      return send(response, 200, { data: null }, origin);
    }
    const occurrenceMoveMatch = url.pathname.match(
      /^\/api\/calendar\/([^/]+)\/occurrences\/move$/,
    );
    if (occurrenceMoveMatch && request.method === 'PUT') {
      const input = await readJson(request);
      database.moveCalendarOccurrences(
        decodeURIComponent(occurrenceMoveMatch[1]),
        input.changes,
      );
      return send(response, 200, { data: null }, origin);
    }
    const seriesMoveMatch = url.pathname.match(
      /^\/api\/calendar\/([^/]+)\/series\/move$/,
    );
    if (seriesMoveMatch && request.method === 'PUT') {
      database.moveCalendarSeries(
        decodeURIComponent(seriesMoveMatch[1]),
        await readJson(request),
      );
      return send(response, 200, { data: null }, origin);
    }
    const groupPreview = url.pathname.match(
      /^\/api\/timeline\/groups\/([^/]+)$/,
    );
    if (groupPreview && request.method === 'GET')
      return send(
        response,
        200,
        {
          data: database.previewTimelineGroup(
            decodeURIComponent(groupPreview[1]),
          ),
        },
        origin,
      );
    const groupMove = url.pathname.match(
      /^\/api\/timeline\/groups\/([^/]+)\/move$/,
    );
    if (groupMove && request.method === 'PUT') {
      const input = await readJson(request);
      database.moveTimelineGroup(
        decodeURIComponent(groupMove[1]),
        input.days,
        input.version,
      );
      return send(response, 200, { data: null }, origin);
    }
    const taskMove = url.pathname.match(
      /^\/api\/timeline\/tasks\/([^/]+)\/move$/,
    );
    if (taskMove && request.method === 'PUT') {
      database.moveTimelineTask(
        decodeURIComponent(taskMove[1]),
        await readJson(request),
      );
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/timeline' && request.method === 'GET')
      return send(
        response,
        200,
        { data: database.getTimelineWorkspace() },
        origin,
      );
    if (
      url.pathname === '/api/timeline/milestones' &&
      request.method === 'POST'
    )
      return send(
        response,
        201,
        { data: database.createTimelineMilestone(await readJson(request)) },
        origin,
      );
    const milestoneMatch = url.pathname.match(
      /^\/api\/timeline\/milestones\/([^/]+)$/,
    );
    if (milestoneMatch && request.method === 'PATCH') {
      database.updateTimelineMilestone(
        decodeURIComponent(milestoneMatch[1]),
        await readJson(request),
      );
      return send(response, 200, { data: null }, origin);
    }
    if (milestoneMatch && request.method === 'DELETE') {
      database.deleteTimelineMilestone(decodeURIComponent(milestoneMatch[1]));
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/settings/theme' && request.method === 'GET')
      return send(response, 200, { data: database.getTheme() }, origin);
    if (url.pathname === '/api/settings/theme' && request.method === 'PUT') {
      database.saveTheme((await readJson(request)).theme);
      return send(response, 200, { data: null }, origin);
    }
    if (url.pathname === '/api/pomodoro' && request.method === 'GET')
      return send(
        response,
        200,
        { data: database.getPomodoroWorkspace() },
        origin,
      );
    if (url.pathname === '/api/pomodoro/settings' && request.method === 'PUT') {
      database.savePomodoroSettings(await readJson(request));
      return send(response, 200, { data: null }, origin);
    }
    if (
      url.pathname === '/api/pomodoro/sessions' &&
      request.method === 'POST'
    ) {
      database.recordPomodoroSession(await readJson(request));
      return send(response, 201, { data: null }, origin);
    }
    if (url.pathname === '/api/reviews' && request.method === 'GET')
      return send(
        response,
        200,
        {
          data: database.getReviewsWorkspace(
            url.searchParams.get('weekStart') ?? '',
            url.searchParams.get('nextWeek') ?? '',
          ),
        },
        origin,
      );
    const reviewMatch = url.pathname.match(
      /^\/api\/reviews\/(\d{4}-\d{2}-\d{2})$/,
    );
    if (reviewMatch && request.method === 'PUT') {
      database.saveWeeklyReview({
        ...(await readJson(request)),
        week_start: reviewMatch[1],
      });
      return send(response, 200, { data: null }, origin);
    }
    return send(response, 404, { error: 'Local API route not found.' }, origin);
  } catch (error) {
    const status =
      Number(error?.statusCode) ||
      (/not found/i.test(error?.message ?? '') ? 404 : 400);
    return send(
      response,
      status,
      {
        error:
          error instanceof Error
            ? error.message
            : 'Local database request failed.',
      },
      origin,
    );
  }
}

server.listen(port, '127.0.0.1', () => {
  console.log(`myplan local database: ${databasePath}`);
  console.log(`myplan local API: http://127.0.0.1:${port}`);
  localControl = registerLocalControl(databasePath, port);
  stopBackups = startBackupScheduler();
});

let stopping = false;
function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await stopBackups();
    database.close();
    localControl?.close();
    releaseDatabase();
    process.exit(exitCode);
  });
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
