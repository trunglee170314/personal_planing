import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installLocalUndo } from './undo.mjs';
import {
  timelineGroupPlan,
  moveTimelineGroup,
  moveTimelineTask,
} from './timeline-commands.mjs';

const priorities = new Set(['low', 'medium', 'high', 'urgent']);
const goalStatuses = new Set(['active', 'completed', 'archived']);
const recurrences = new Set(['none', 'daily', 'weekly', 'monthly', 'custom']);
const calendarItemTypes = new Set(['checklist', 'reminder']);
const notificationOffsets = new Set([0, 5, 15, 60, 1440]);
const taskColumns =
  'id,title,priority,due_at,completed_at,workflow_status_id,previous_status_id,planned_start,planned_end,progress,parent_task_id,dependency_task_id,is_milestone,archived_at,deleted_at,link_url,link_label';
const now = () => new Date().toISOString();
function requireText(value, name, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max)
    throw new Error(`${name} must contain between 1 and ${max} characters.`);
  return text;
}
function nullableText(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Expected text or null.');
  return value;
}
function booleanValue(value) {
  return value ? 1 : 0;
}
function validateDateYear(value, name) {
  if (!value) return;
  const year = new Date(value).getFullYear();
  if (!Number.isFinite(year) || year < 2000 || year > 2200)
    throw new Error(`${name} must use a year between 2000 and 2200.`);
}
function validateHttpUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Task link must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Task link must start with http:// or https://.');
  return url.toString();
}
function addUtcDays(value, amount) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date;
}
function addVietnamMonths(value, amount) {
  const local = new Date(new Date(value).getTime() + 7 * 3_600_000);
  const targetFirst = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + amount, 1),
  );
  const daysInTarget = new Date(
    Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      targetFirst.getUTCFullYear(),
      targetFirst.getUTCMonth(),
      Math.min(local.getUTCDate(), daysInTarget),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) -
      7 * 3_600_000,
  );
}
function vietnamDayNumber(value) {
  const dateKey = new Date(new Date(value).getTime() + 7 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  return Date.parse(`${dateKey}T00:00:00.000Z`) / 86_400_000;
}
function shiftDateOnly(value, dayDelta) {
  if (!value || !dayDelta) return value;
  return addUtcDays(new Date(`${value}T00:00:00.000Z`), dayDelta)
    .toISOString()
    .slice(0, 10);
}
function expandSessionOccurrences(session, states = []) {
  if (session.recurrence === 'none')
    return [
      {
        occurrence_start: session.starts_at,
        completed_at: session.completed_at,
        not_needed_at: session.not_needed_at,
      },
    ];
  if (!session.recurrence_until) return [];
  const stateMap = new Map(
    states.map((state) => [state.occurrence_start, state]),
  );
  const until = new Date(`${session.recurrence_until}T16:59:59.999Z`).getTime();
  let occurrence = new Date(session.starts_at);
  const result = [];
  for (
    let safety = 0;
    occurrence.getTime() <= until && safety < 1000;
    safety += 1
  ) {
    const occurrenceStart = occurrence.toISOString();
    const state = stateMap.get(occurrenceStart);
    result.push({
      occurrence_start: occurrenceStart,
      completed_at: state?.completed_at ?? null,
      not_needed_at: state?.not_needed_at ?? null,
    });
    if (session.recurrence === 'daily') occurrence = addUtcDays(occurrence, 1);
    else if (session.recurrence === 'weekly')
      occurrence = addUtcDays(occurrence, 7);
    else if (session.recurrence === 'custom')
      occurrence = addUtcDays(
        occurrence,
        Math.max(1, session.recurrence_interval || 1),
      );
    else occurrence = addVietnamMonths(session.starts_at, safety + 1);
  }
  return result;
}

export class LocalDatabase {
  previewTimelineGroup(goalId) {
    return timelineGroupPlan(this, goalId);
  }
  moveTimelineGroup(goalId, days, version) {
    return moveTimelineGroup(this, goalId, days, version);
  }
  moveTimelineTask(id, input) {
    return moveTimelineTask(this, id, input);
  }
  transactionDepth = 0;
  beginTransaction() {
    const depth = this.transactionDepth;
    this.db.exec(depth ? `SAVEPOINT myplan_${depth}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
  }
  commitTransaction() {
    const depth = this.transactionDepth - 1;
    this.db.exec(depth ? `RELEASE SAVEPOINT myplan_${depth}` : 'COMMIT');
    this.transactionDepth = depth;
  }
  rollbackTransaction() {
    const depth = this.transactionDepth - 1;
    this.db.exec(
      depth
        ? `ROLLBACK TO SAVEPOINT myplan_${depth}; RELEASE SAVEPOINT myplan_${depth}`
        : 'ROLLBACK',
    );
    this.transactionDepth = depth;
  }
  saveTaskEdit(id, changes, completed) {
    this.beginTransaction();
    try {
      const current = this.db
        .prepare('SELECT completed_at,workflow_status_id FROM tasks WHERE id=?')
        .get(id);
      if (!current) throw new Error('Task not found.');
      const nextCategory = this.db
        .prepare('SELECT category FROM workflow_statuses WHERE id=?')
        .get(
          changes.workflow_status_id ?? current.workflow_status_id,
        )?.category;
      if (!completed && nextCategory === 'completed')
        throw new Error('Task status and completion must agree.');
      if (current.completed_at && !completed) this.setTaskCompletion(id, false);
      if (
        !completed &&
        this.db.prepare('SELECT completed_at FROM tasks WHERE id=?').get(id)
          ?.completed_at
      )
        throw new Error(
          'This Task is complete because its checklists are complete. Reopen a checklist first.',
        );
      this.updateTask(id, {
        ...changes,
        workflow_status_id: completed
          ? current.workflow_status_id
          : changes.workflow_status_id,
      });
      if (!current.completed_at && completed) this.setTaskCompletion(id, true);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(databasePath), 0o700);
    }
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    for (const path of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ])
      if (path !== ':memory:' && existsSync(path)) chmodSync(path, 0o600);
    this.migrate();
    this.bootstrap();
    installLocalUndo(this);
  }
  addColumn(table, definition) {
    const name = definition.split(' ')[0];
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name))
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,horizon TEXT,starts_on TEXT,ends_on TEXT,progress INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',completed_at TEXT,archived_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY,name TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_statuses (id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,name TEXT NOT NULL,category TEXT NOT NULL,position INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(workflow_id,category));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,workflow_status_id TEXT NOT NULL REFERENCES workflow_statuses(id),previous_status_id TEXT REFERENCES workflow_statuses(id),title TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'medium',due_at TEXT,completed_at TEXT,archived_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_goal_links (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(task_id,goal_id));
      CREATE TABLE IF NOT EXISTS weekly_reviews (id TEXT PRIMARY KEY,week_start TEXT NOT NULL UNIQUE,wins TEXT NOT NULL DEFAULT '',challenges TEXT NOT NULL DEFAULT '',next_week_focus TEXT NOT NULL DEFAULT '',satisfaction INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_sessions (id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,title TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,all_day INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',recurrence TEXT NOT NULL DEFAULT 'none',recurrence_until TEXT,recurrence_interval INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pomodoro_settings (id TEXT PRIMARY KEY,focus_minutes INTEGER NOT NULL,short_break_minutes INTEGER NOT NULL,long_break_minutes INTEGER NOT NULL,daily_target_type TEXT NOT NULL,daily_target_value INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pomodoro_sessions (id TEXT PRIMARY KEY,client_id TEXT UNIQUE,started_at TEXT NOT NULL,completed_at TEXT NOT NULL,duration_minutes INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS timeline_milestones (id TEXT PRIMARY KEY,goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,title TEXT NOT NULL,milestone_on TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_occurrence_states (calendar_entry_id TEXT NOT NULL REFERENCES calendar_sessions(id) ON DELETE CASCADE,occurrence_start TEXT NOT NULL,completed_at TEXT,not_needed_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(calendar_entry_id,occurrence_start));
      CREATE TABLE IF NOT EXISTS app_settings (id TEXT PRIMARY KEY,theme TEXT NOT NULL DEFAULT 'jade',updated_at TEXT NOT NULL);
    `);
    this.addColumn('goals', 'starts_on TEXT');
    this.addColumn('goals', 'deleted_at TEXT');
    this.addColumn('goals', "color_key TEXT NOT NULL DEFAULT 'jade'");
    this.addColumn(
      'calendar_sessions',
      'recurrence_interval INTEGER NOT NULL DEFAULT 1',
    );
    this.addColumn('pomodoro_sessions', 'client_id TEXT');
    this.addColumn('tasks', 'planned_start TEXT');
    this.addColumn('tasks', 'planned_end TEXT');
    this.addColumn('tasks', 'progress INTEGER NOT NULL DEFAULT 0');
    this.addColumn(
      'tasks',
      'parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL',
    );
    this.addColumn(
      'tasks',
      'dependency_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL',
    );
    this.addColumn('tasks', 'is_milestone INTEGER NOT NULL DEFAULT 0');
    this.addColumn('tasks', 'deleted_at TEXT');
    this.addColumn('tasks', 'link_url TEXT');
    this.addColumn('tasks', 'link_label TEXT');
    this.addColumn(
      'calendar_sessions',
      "item_type TEXT NOT NULL DEFAULT 'checklist'",
    );
    this.addColumn('calendar_sessions', 'completed_at TEXT');
    this.addColumn('calendar_sessions', 'not_needed_at TEXT');
    this.addColumn(
      'calendar_sessions',
      "notification_offsets TEXT NOT NULL DEFAULT '[15]'",
    );
    this.addColumn('calendar_sessions', 'is_pinned INTEGER NOT NULL DEFAULT 0');
    this.addColumn('calendar_occurrence_states', 'override_starts_at TEXT');
    this.addColumn('calendar_occurrence_states', 'override_ends_at TEXT');
    this.addColumn(
      'timeline_milestones',
      'task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL',
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS planner_annotations (
        id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        calendar_entry_id TEXT REFERENCES calendar_sessions(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES timeline_milestones(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('comment','link')),body TEXT NOT NULL,url TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        CHECK((task_id IS NOT NULL)+(calendar_entry_id IS NOT NULL)+(milestone_id IS NOT NULL)=1));
      CREATE INDEX IF NOT EXISTS annotation_task ON planner_annotations(task_id,created_at);
      CREATE INDEX IF NOT EXISTS annotation_calendar ON planner_annotations(calendar_entry_id,created_at);
      CREATE INDEX IF NOT EXISTS annotation_milestone ON planner_annotations(milestone_id,created_at);
      CREATE TABLE IF NOT EXISTS planner_holidays (id TEXT PRIMARY KEY,title TEXT NOT NULL,starts_on TEXT NOT NULL,ends_on TEXT NOT NULL,created_at TEXT NOT NULL,CHECK(ends_on>=starts_on));
      CREATE TRIGGER IF NOT EXISTS milestone_one_parent_insert BEFORE INSERT ON timeline_milestones WHEN NEW.task_id IS NOT NULL AND NEW.goal_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Milestone can belong to Task or Goal, not both.'); END;
      CREATE TRIGGER IF NOT EXISTS milestone_one_parent_update BEFORE UPDATE ON timeline_milestones WHEN NEW.task_id IS NOT NULL AND NEW.goal_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Milestone can belong to Task or Goal, not both.'); END;
    `);
    this.db.exec(`UPDATE calendar_sessions
      SET item_type='reminder',
          ends_at=strftime('%Y-%m-%dT%H:%M:%fZ',starts_at,'+15 minutes'),
          updated_at=datetime('now')
      WHERE item_type='checklist' AND task_id IS NULL;`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_goals_lifecycle_created ON goals(deleted_at,status,created_at DESC); CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_created ON tasks(deleted_at,archived_at,created_at DESC); CREATE INDEX IF NOT EXISTS idx_tasks_active_due_at ON tasks(due_at) WHERE archived_at IS NULL AND deleted_at IS NULL; CREATE INDEX IF NOT EXISTS idx_tasks_active_plan ON tasks(planned_start,due_at) WHERE archived_at IS NULL AND deleted_at IS NULL; CREATE INDEX IF NOT EXISTS idx_calendar_range ON calendar_sessions(starts_at,ends_at); CREATE INDEX IF NOT EXISTS idx_calendar_task ON calendar_sessions(task_id); CREATE INDEX IF NOT EXISTS idx_calendar_reminder_overdue ON calendar_sessions(starts_at) WHERE item_type='reminder' AND completed_at IS NULL AND not_needed_at IS NULL; CREATE INDEX IF NOT EXISTS idx_milestones_date ON timeline_milestones(milestone_on); CREATE INDEX IF NOT EXISTS idx_pomodoro_completed ON pomodoro_sessions(completed_at DESC); CREATE INDEX IF NOT EXISTS idx_reviews_week ON weekly_reviews(week_start DESC); PRAGMA optimize;`,
    );
  }
  bootstrap() {
    const timestamp = now();
    const workflowId = 'local-default-workflow';
    this.db
      .prepare(
        'INSERT OR IGNORE INTO workflows (id,name,is_default,created_at,updated_at) VALUES (?,?,?,?,?)',
      )
      .run(workflowId, 'My workflow', 1, timestamp, timestamp);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO workflow_statuses (id,workflow_id,name,category,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    );
    [
      ['local-status-backlog', 'Backlog', 'backlog'],
      ['local-status-planned', 'Planned', 'planned'],
      ['local-status-in-progress', 'In progress', 'in_progress'],
      ['local-status-blocked', 'Blocked', 'blocked'],
      ['local-status-completed', 'Completed', 'completed'],
      ['local-status-cancelled', 'Cancelled', 'cancelled'],
      ['local-status-archived', 'Archived', 'archived'],
    ].forEach(([id, name, category], position) =>
      insert.run(
        id,
        workflowId,
        name,
        category,
        position,
        timestamp,
        timestamp,
      ),
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pomodoro_settings (id,focus_minutes,short_break_minutes,long_break_minutes,daily_target_type,daily_target_value,updated_at) VALUES ('local',25,5,15,'sessions',4,?)",
      )
      .run(timestamp);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO app_settings (id,theme,updated_at) VALUES ('local','jade',?)",
      )
      .run(timestamp);
  }
  close() {
    this.db.close();
  }
  listStatuses() {
    return this.db
      .prepare('SELECT id,category FROM workflow_statuses ORDER BY position')
      .all();
  }
  goalTaskProgress(goalId) {
    return this.db
      .prepare(
        `WITH eligible AS (
          SELECT tasks.id,tasks.parent_task_id,workflow_statuses.category
          FROM tasks
          JOIN task_goal_links ON task_goal_links.task_id=tasks.id
          JOIN workflow_statuses ON workflow_statuses.id=tasks.workflow_status_id
          WHERE task_goal_links.goal_id=?
            AND tasks.archived_at IS NULL
            AND tasks.deleted_at IS NULL
            AND workflow_statuses.category<>'cancelled'
        )
        SELECT count(*) AS task_count,
          coalesce(sum(CASE WHEN category='completed' THEN 1 ELSE 0 END),0) AS completed_task_count
        FROM eligible AS task
        WHERE NOT EXISTS (
          SELECT 1 FROM eligible AS child WHERE child.parent_task_id=task.id
        )`,
      )
      .get(goalId);
  }
  syncGoalProgress(goalId) {
    if (!goalId) return;
    const goal = this.db
      .prepare('SELECT id,status,deleted_at,completed_at FROM goals WHERE id=?')
      .get(goalId);
    if (!goal || goal.status === 'archived' || goal.deleted_at) return;
    const summary = this.goalTaskProgress(goalId);
    if (!summary?.task_count) return;
    const completed = summary.completed_task_count === summary.task_count;
    const progress = Math.round(
      (summary.completed_task_count / summary.task_count) * 100,
    );
    this.db
      .prepare(
        'UPDATE goals SET progress=?,status=?,completed_at=?,updated_at=? WHERE id=?',
      )
      .run(
        progress,
        completed ? 'completed' : 'active',
        completed ? (goal.completed_at ?? now()) : null,
        now(),
        goalId,
      );
  }
  listGoals(view = 'active') {
    const where =
      view === 'trash'
        ? 'deleted_at IS NOT NULL'
        : view === 'archived'
          ? "status = 'archived' AND deleted_at IS NULL"
          : "status <> 'archived' AND deleted_at IS NULL";
    return this.db
      .prepare(
        `SELECT id,title,description,progress,status,starts_on,ends_on,archived_at,deleted_at,color_key FROM goals WHERE ${where} ORDER BY created_at DESC,id`,
      )
      .all()
      .map((goal) => ({ ...goal, ...this.goalTaskProgress(goal.id) }));
  }
  createGoal(input) {
    const timestamp = now();
    const startsOn = nullableText(input.starts_on);
    const endsOn = nullableText(input.ends_on);
    validateDateYear(startsOn, 'Goal start date');
    validateDateYear(endsOn, 'Goal deadline');
    if (startsOn && endsOn && endsOn < startsOn)
      throw new Error('Goal end date cannot be before its start date.');
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO goals (id,title,description,horizon,starts_on,ends_on,color_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        requireText(input.title, 'Goal title', 200),
        nullableText(input.description),
        null,
        startsOn,
        endsOn,
        input.color_key || 'jade',
        timestamp,
        timestamp,
      );
    return id;
  }
  updateGoal(id, changes) {
    const current = this.db
      .prepare('SELECT id,starts_on,ends_on FROM goals WHERE id=?')
      .get(id);
    if (!current) throw new Error('Goal not found.');
    const nextStart =
      'starts_on' in changes ? changes.starts_on : current.starts_on;
    const nextEnd = 'ends_on' in changes ? changes.ends_on : current.ends_on;
    if (nextStart && nextEnd && nextEnd < nextStart)
      throw new Error('Goal end date cannot be before its start date.');
    const allowed = [
      'title',
      'description',
      'starts_on',
      'ends_on',
      'progress',
      'status',
      'completed_at',
      'archived_at',
      'deleted_at',
      'color_key',
    ];
    const values = [];
    const sets = [];
    for (const key of allowed)
      if (key in changes) {
        let value = changes[key];
        if (key === 'title') value = requireText(value, 'Goal title', 200);
        if (key === 'status' && !goalStatuses.has(changes[key]))
          throw new Error('Invalid goal status.');
        if (
          key === 'progress' &&
          (!Number.isInteger(changes[key]) ||
            changes[key] < 0 ||
            changes[key] > 100)
        )
          throw new Error('Goal progress must be between 0 and 100.');
        sets.push(`${key}=?`);
        values.push(value ?? null);
      }
    if (!sets.length) return;
    sets.push('updated_at=?');
    values.push(now(), id);
    this.db
      .prepare(`UPDATE goals SET ${sets.join(',')} WHERE id=?`)
      .run(...values);
    this.syncGoalProgress(id);
  }
  deleteGoal(id) {
    if (!this.db.prepare('SELECT id FROM goals WHERE id=?').get(id))
      throw new Error('Goal not found.');
    this.beginTransaction();
    try {
      this.db.prepare('DELETE FROM task_goal_links WHERE goal_id=?').run(id);
      this.db.prepare('DELETE FROM goals WHERE id=?').run(id);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  getTaskWorkspace(view = 'active') {
    const taskWhere =
      view === 'trash'
        ? 'deleted_at IS NOT NULL'
        : view === 'archived'
          ? 'archived_at IS NOT NULL AND deleted_at IS NULL'
          : 'archived_at IS NULL AND deleted_at IS NULL';
    return {
      goals: this.db
        .prepare(
          "SELECT id,title,color_key FROM goals WHERE status <> 'archived' AND deleted_at IS NULL ORDER BY created_at DESC,id",
        )
        .all(),
      statuses: this.listStatuses(),
      tasks: this.db
        .prepare(
          `SELECT ${taskColumns} FROM tasks WHERE ${taskWhere} ORDER BY created_at DESC,id`,
        )
        .all()
        .map((row) => ({
          ...this.normalizeTask(row),
          ...(() => {
            const summary = this.checklistOccurrenceSummary(row.id);
            return {
              active_checklist_count: summary.total,
              checklist_resolved_count: summary.resolved,
              checklist_done_count: summary.completed,
              progress: summary.total
                ? Math.round((summary.resolved * 100) / summary.total)
                : Number(row.progress) || 0,
            };
          })(),
        })),
      links: this.db
        .prepare('SELECT task_id,goal_id FROM task_goal_links')
        .all(),
    };
  }
  normalizeTask = (row) => ({
    ...row,
    is_milestone: Boolean(row.is_milestone),
    active_checklist_count: Number(row.active_checklist_count) || 0,
    checklist_resolved_count: Number(row.checklist_resolved_count) || 0,
    checklist_done_count: Number(row.checklist_done_count) || 0,
  });
  validateTaskHierarchy(id, parentId, goalId) {
    const seen = new Set(id ? [id] : []);
    let current = parentId;
    while (current) {
      if (seen.has(current))
        throw new Error('A task cannot be its own ancestor.');
      seen.add(current);
      const row = this.db
        .prepare('SELECT id,parent_task_id FROM tasks WHERE id=?')
        .get(current);
      if (!row) throw new Error('Parent task not found.');
      const parentGoal = this.db
        .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
        .get(current)?.goal_id;
      if ((parentGoal || null) !== (goalId || null))
        throw new Error('Parent task must belong to the same Goal.');
      current = row.parent_task_id;
    }
    if (id) {
      const children = this.db
        .prepare(
          'SELECT t.id,l.goal_id FROM tasks t LEFT JOIN task_goal_links l ON l.task_id=t.id WHERE t.parent_task_id=?',
        )
        .all(id);
      if (
        children.some((child) => (child.goal_id || null) !== (goalId || null))
      )
        throw new Error(
          'Move or detach child tasks before changing this task’s Goal.',
        );
    }
  }
  createTask(input) {
    this.validateTaskHierarchy(null, input.parent_task_id, input.goal_id);
    if (!priorities.has(input.priority))
      throw new Error('Invalid task priority.');
    if (
      !this.db
        .prepare('SELECT id FROM workflow_statuses WHERE id=?')
        .get(input.workflow_status_id)
    )
      throw new Error('Workflow status not found.');
    const id = randomUUID();
    const timestamp = now();
    const plannedStart = nullableText(input.planned_start);
    const plannedEnd = nullableText(input.planned_end);
    const deadline = nullableText(input.due_at);
    validateDateYear(plannedStart, 'Task start date');
    validateDateYear(deadline, 'Task deadline');
    if (
      plannedStart &&
      deadline &&
      deadline.slice(0, 10) < plannedStart.slice(0, 10)
    )
      throw new Error('Task deadline cannot be before its start date.');
    if (plannedStart && plannedEnd && plannedEnd < plannedStart)
      throw new Error('Planned end cannot be before planned start.');
    this.beginTransaction();
    try {
      this.db
        .prepare(
          'INSERT INTO tasks (id,title,priority,due_at,workflow_status_id,planned_start,planned_end,progress,parent_task_id,dependency_task_id,is_milestone,link_url,link_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          requireText(input.title, 'Task title', 240),
          input.priority,
          deadline,
          input.workflow_status_id,
          plannedStart,
          plannedEnd,
          Number(input.progress) || 0,
          nullableText(input.parent_task_id),
          nullableText(input.dependency_task_id),
          booleanValue(input.is_milestone),
          validateHttpUrl(input.link_url),
          nullableText(input.link_label),
          timestamp,
          timestamp,
        );
      if (input.goal_id)
        this.db
          .prepare(
            'INSERT INTO task_goal_links (task_id,goal_id,created_at) VALUES (?,?,?)',
          )
          .run(id, input.goal_id, timestamp);
      this.syncGoalProgress(input.goal_id);
      this.commitTransaction();
      return id;
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  updateTask(id, changes) {
    const current = this.db
      .prepare(
        'SELECT id,parent_task_id,planned_start,planned_end,due_at,workflow_status_id,completed_at,progress FROM tasks WHERE id=?',
      )
      .get(id);
    if (!current) throw new Error('Task not found.');
    const previousGoalId = this.db
      .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
      .get(id)?.goal_id;
    if ('parent_task_id' in changes || 'goal_id' in changes)
      this.validateTaskHierarchy(
        id,
        'parent_task_id' in changes
          ? changes.parent_task_id
          : current.parent_task_id,
        'goal_id' in changes ? changes.goal_id : previousGoalId,
      );
    if (
      'workflow_status_id' in changes ||
      'completed_at' in changes ||
      'progress' in changes
    ) {
      const checklist = this.checklistOccurrenceSummary(id);
      const changesDerivedState =
        ('workflow_status_id' in changes &&
          changes.workflow_status_id !== current.workflow_status_id &&
          (this.db
            .prepare('SELECT category FROM workflow_statuses WHERE id=?')
            .get(changes.workflow_status_id)?.category === 'completed' ||
            this.db
              .prepare('SELECT category FROM workflow_statuses WHERE id=?')
              .get(current.workflow_status_id)?.category === 'completed')) ||
        ('completed_at' in changes &&
          Boolean(changes.completed_at) !== Boolean(current.completed_at)) ||
        ('progress' in changes && changes.progress !== current.progress);
      if (checklist.total > 0 && changesDerivedState)
        throw new Error(
          'Use the Task completion control when checklist items are attached.',
        );
    }
    const nextStart =
      'planned_start' in changes
        ? changes.planned_start
        : current.planned_start;
    const nextEnd =
      'planned_end' in changes ? changes.planned_end : current.planned_end;
    if ('planned_start' in changes || 'due_at' in changes) {
      validateDateYear(nextStart, 'Task start date');
      validateDateYear(
        'due_at' in changes ? changes.due_at : current.due_at,
        'Task deadline',
      );
    }
    const nextDeadline = 'due_at' in changes ? changes.due_at : current.due_at;
    if ('planned_start' in changes || 'due_at' in changes) {
      if (
        nextStart &&
        nextDeadline &&
        String(nextDeadline).slice(0, 10) < String(nextStart).slice(0, 10)
      )
        throw new Error('Task deadline cannot be before its start date.');
      if (nextStart && nextEnd && nextEnd < nextStart)
        throw new Error('Planned end cannot be before planned start.');
    }
    const allowed = [
      'title',
      'priority',
      'due_at',
      'completed_at',
      'workflow_status_id',
      'previous_status_id',
      'planned_start',
      'planned_end',
      'progress',
      'parent_task_id',
      'dependency_task_id',
      'is_milestone',
      'archived_at',
      'deleted_at',
      'link_url',
      'link_label',
    ];
    const values = [];
    const sets = [];
    for (const key of allowed)
      if (key in changes) {
        let value = changes[key];
        if (key === 'title') value = requireText(value, 'Task title', 240);
        if (key === 'priority' && !priorities.has(changes[key]))
          throw new Error('Invalid task priority.');
        if (key === 'link_url') value = validateHttpUrl(value);
        if (
          key === 'progress' &&
          (!Number.isInteger(changes[key]) ||
            changes[key] < 0 ||
            changes[key] > 100)
        )
          throw new Error('Task progress must be between 0 and 100.');
        sets.push(`${key}=?`);
        values.push(
          key === 'is_milestone' ? booleanValue(value) : (value ?? null),
        );
      }
    this.beginTransaction();
    try {
      if (sets.length) {
        sets.push('updated_at=?');
        values.push(now(), id);
        this.db
          .prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`)
          .run(...values);
      }
      if ('goal_id' in changes) {
        this.db.prepare('DELETE FROM task_goal_links WHERE task_id=?').run(id);
        if (changes.goal_id)
          this.db
            .prepare(
              'INSERT INTO task_goal_links (task_id,goal_id,created_at) VALUES (?,?,?)',
            )
            .run(id, changes.goal_id, now());
      }
      const nextGoalId = this.db
        .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
        .get(id)?.goal_id;
      this.syncGoalProgress(previousGoalId);
      if (nextGoalId !== previousGoalId) this.syncGoalProgress(nextGoalId);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  setTaskCompletion(id, completed) {
    const task = this.db
      .prepare(
        `SELECT t.id,t.workflow_status_id,t.previous_status_id,t.completed_at,s.category
         FROM tasks t JOIN workflow_statuses s ON s.id=t.workflow_status_id
         WHERE t.id=?`,
      )
      .get(id);
    if (!task) throw new Error('Task not found.');
    if (Boolean(task.completed_at) === completed) return;
    const timestamp = now();
    const goalId = this.db
      .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
      .get(id)?.goal_id;
    this.beginTransaction();
    try {
      if (completed) {
        const completedStatus = this.db
          .prepare('SELECT id FROM workflow_statuses WHERE category=?')
          .get('completed');
        this.db
          .prepare(
            `UPDATE calendar_sessions
             SET not_needed_at=?,updated_at=?
             WHERE task_id=? AND item_type='checklist'
               AND completed_at IS NULL AND not_needed_at IS NULL`,
          )
          .run(timestamp, timestamp, id);
        const repeating = this.db
          .prepare(
            `SELECT * FROM calendar_sessions
             WHERE task_id=? AND item_type='checklist' AND recurrence<>'none'`,
          )
          .all(id);
        const state = this.db.prepare(
          `INSERT INTO calendar_occurrence_states
             (calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at,updated_at)
           VALUES (?,?,NULL,?,NULL,NULL,?)
           ON CONFLICT(calendar_entry_id,occurrence_start) DO UPDATE SET
             not_needed_at=excluded.not_needed_at,updated_at=excluded.updated_at
           WHERE calendar_occurrence_states.completed_at IS NULL
             AND calendar_occurrence_states.not_needed_at IS NULL`,
        );
        for (const session of repeating)
          for (const occurrence of expandSessionOccurrences(
            session,
            this.db
              .prepare(
                'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=?',
              )
              .all(session.id),
          ))
            state.run(
              session.id,
              occurrence.occurrence_start,
              timestamp,
              timestamp,
            );
        this.db
          .prepare(
            `UPDATE tasks SET previous_status_id=?,workflow_status_id=?,completed_at=?,progress=100,updated_at=? WHERE id=?`,
          )
          .run(
            task.category === 'completed'
              ? task.previous_status_id
              : task.workflow_status_id,
            completedStatus.id,
            timestamp,
            timestamp,
            id,
          );
      } else {
        this.db
          .prepare(
            `UPDATE calendar_sessions SET not_needed_at=NULL,updated_at=?
             WHERE task_id=? AND item_type='checklist' AND not_needed_at=?`,
          )
          .run(timestamp, id, task.completed_at);
        this.db
          .prepare(
            `UPDATE calendar_occurrence_states SET not_needed_at=NULL,updated_at=?
             WHERE calendar_entry_id IN (
               SELECT id FROM calendar_sessions
               WHERE task_id=? AND item_type='checklist'
             ) AND not_needed_at=?`,
          )
          .run(timestamp, id, task.completed_at);
        const fallback =
          task.previous_status_id ??
          this.db
            .prepare('SELECT id FROM workflow_statuses WHERE category=?')
            .get('planned')?.id ??
          'backlog';
        this.db
          .prepare(
            `UPDATE tasks SET workflow_status_id=?,previous_status_id=NULL,completed_at=NULL,progress=0,updated_at=? WHERE id=?`,
          )
          .run(fallback, timestamp, id);
        this.syncTaskChecklistProgress(id);
      }
      this.syncGoalProgress(goalId);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  deleteTask(id) {
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))
      throw new Error('Task not found.');
    const goalId = this.db
      .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
      .get(id)?.goal_id;
    this.beginTransaction();
    try {
      this.db
        .prepare('UPDATE tasks SET parent_task_id=NULL WHERE parent_task_id=?')
        .run(id);
      this.db
        .prepare(
          'UPDATE tasks SET dependency_task_id=NULL WHERE dependency_task_id=?',
        )
        .run(id);
      const convertSession = this.db.prepare(
        "UPDATE calendar_sessions SET task_id=NULL,item_type='reminder',ends_at=?,updated_at=? WHERE id=?",
      );
      for (const session of this.db
        .prepare('SELECT id,starts_at FROM calendar_sessions WHERE task_id=?')
        .all(id))
        convertSession.run(
          new Date(
            new Date(session.starts_at).getTime() + 15 * 60_000,
          ).toISOString(),
          now(),
          session.id,
        );
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      this.syncGoalProgress(goalId);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  getCalendarWorkspace() {
    return {
      goals: this.db
        .prepare(
          "SELECT id,title,color_key FROM goals WHERE status <> 'archived' AND deleted_at IS NULL ORDER BY created_at DESC,id",
        )
        .all(),
      tasks: this.db
        .prepare(
          `SELECT ${taskColumns} FROM tasks WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at,id`,
        )
        .all()
        .map(this.normalizeTask),
      statuses: this.listStatuses(),
      links: this.db
        .prepare('SELECT task_id,goal_id FROM task_goal_links')
        .all(),
      sessions: this.db
        .prepare(
          'SELECT id,task_id,title,starts_at,ends_at,all_day,timezone,recurrence,recurrence_until,recurrence_interval,item_type,completed_at,not_needed_at,notification_offsets,is_pinned FROM calendar_sessions ORDER BY starts_at DESC,id',
        )
        .all()
        .map((row) => ({
          ...row,
          all_day: Boolean(row.all_day),
          is_pinned: Boolean(row.is_pinned),
          notification_offsets: this.parseNotificationOffsets(
            row.notification_offsets,
          ),
        }))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
      occurrence_states: this.db
        .prepare(
          'SELECT calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at FROM calendar_occurrence_states ORDER BY occurrence_start DESC,calendar_entry_id',
        )
        .all(),
    };
  }
  getTodayWorkspace() {
    return this.getCalendarWorkspace();
  }
  createCalendarSession(input) {
    this.validateSession(input);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO calendar_sessions (id,task_id,title,starts_at,ends_at,all_day,timezone,recurrence,recurrence_until,recurrence_interval,item_type,completed_at,not_needed_at,notification_offsets,is_pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        nullableText(input.task_id),
        requireText(input.title, 'Session title', 240),
        input.starts_at,
        input.ends_at,
        booleanValue(input.all_day),
        input.timezone || 'Asia/Ho_Chi_Minh',
        input.recurrence || 'none',
        nullableText(input.recurrence_until),
        Math.max(1, Number(input.recurrence_interval) || 1),
        input.item_type || 'checklist',
        nullableText(input.completed_at),
        nullableText(input.not_needed_at),
        JSON.stringify(input.notification_offsets || [15]),
        booleanValue(input.is_pinned),
        timestamp,
        timestamp,
      );
    this.syncTaskChecklistProgress(input.task_id);
    return id;
  }
  validateSession(input) {
    requireText(input.title, 'Session title', 240);
    if (
      !input.starts_at ||
      !input.ends_at ||
      new Date(input.ends_at) <= new Date(input.starts_at)
    )
      throw new Error('Session end must be after its start.');
    if (!recurrences.has(input.recurrence || 'none'))
      throw new Error('Invalid recurrence.');
    if (!calendarItemTypes.has(input.item_type || 'checklist'))
      throw new Error('Invalid calendar item type.');
    if ((input.timezone || 'Asia/Ho_Chi_Minh') !== 'Asia/Ho_Chi_Minh')
      throw new Error('Calendar timezone must be Vietnam.');
    const offsets =
      typeof input.notification_offsets === 'string'
        ? this.parseNotificationOffsets(input.notification_offsets)
        : (input.notification_offsets ?? [15]);
    if (
      !Array.isArray(offsets) ||
      offsets.some((offset) => !notificationOffsets.has(Number(offset)))
    )
      throw new Error('Invalid notification offset.');
    if (input.completed_at && input.not_needed_at)
      throw new Error(
        'An item cannot be done and not needed at the same time.',
      );
    if (input.item_type === 'checklist' && !input.task_id)
      throw new Error('Choose a Task for this checklist.');
    if (input.item_type === 'reminder' && input.task_id)
      throw new Error('A Reminder cannot be linked to a Task.');
    if (
      input.item_type === 'checklist' &&
      input.recurrence !== 'none' &&
      !input.recurrence_until
    )
      throw new Error('Choose an end date for a repeating checklist.');
    if (
      input.recurrence_until &&
      input.recurrence_until < input.starts_at.slice(0, 10)
    )
      throw new Error('Repeat-until date cannot be before the start date.');
    if (
      input.item_type === 'reminder' &&
      new Date(input.ends_at).getTime() -
        new Date(input.starts_at).getTime() !==
        15 * 60_000
    )
      throw new Error('A Reminder uses one point in time.');
  }
  parseNotificationOffsets(value) {
    try {
      const parsed = JSON.parse(value || '[15]');
      if (
        Array.isArray(parsed) &&
        parsed.every((offset) => notificationOffsets.has(Number(offset)))
      )
        return parsed.map(Number);
    } catch {
      // Corrupt legacy settings should not break the whole calendar.
    }
    return [15];
  }
  updateCalendarSession(id, changes, expected) {
    this.beginTransaction();
    try {
      const current = this.db
        .prepare('SELECT * FROM calendar_sessions WHERE id=?')
        .get(id);
      if (!current) throw new Error('Calendar session not found.');
      if (expected)
        for (const key of Object.keys(changes)) {
          const normalize = (value) =>
            key === 'notification_offsets'
              ? typeof value === 'string'
                ? value
                : JSON.stringify(value ?? [])
              : key === 'all_day' || key === 'is_pinned'
                ? Boolean(value)
                : key === 'recurrence_interval'
                  ? (value ?? 1)
                  : (value ?? null);
          if (normalize(current[key]) !== normalize(expected[key]))
            throw new Error(
              'This calendar item changed. Reopen it before saving.',
            );
        }
      const patched = { ...current, ...changes };
      this.validateSession(patched);
      if (
        expected &&
        (patched.starts_at !== current.starts_at ||
          patched.ends_at !== current.ends_at) &&
        ['recurrence', 'recurrence_until', 'recurrence_interval'].some(
          (key) => (current[key] ?? null) !== (expected[key] ?? null),
        )
      )
        throw new Error(
          'This repeat rule changed. Reopen the item before moving it.',
        );
      const patternChanged =
        patched.recurrence !== current.recurrence ||
        (patched.recurrence_interval ?? 1) !==
          (current.recurrence_interval ?? 1);
      if (
        patternChanged &&
        (current.completed_at ||
          current.not_needed_at ||
          this.db
            .prepare(
              'SELECT 1 FROM calendar_occurrence_states WHERE calendar_entry_id=? LIMIT 1',
            )
            .get(id))
      )
        throw new Error(
          'This series has history. Keep its repeat pattern or create a new series.',
        );
      let metadata = changes;
      if (
        !patternChanged &&
        current.recurrence !== 'none' &&
        (patched.starts_at !== current.starts_at ||
          patched.ends_at !== current.ends_at)
      ) {
        this.moveCalendarSeries(id, {
          original_start: current.starts_at,
          original_end: current.ends_at,
          next_start: patched.starts_at,
          next_end: patched.ends_at,
        });
        metadata = { ...changes };
        if (patched.recurrence_until === current.recurrence_until)
          delete metadata.recurrence_until;
      }
      this.updateCalendarSessionNow(id, metadata);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  updateCalendarSessionNow(id, changes) {
    const current = this.db
      .prepare('SELECT * FROM calendar_sessions WHERE id=?')
      .get(id);
    if (!current) throw new Error('Calendar session not found.');
    this.validateSession({ ...current, ...changes });
    const allowed = [
      'task_id',
      'title',
      'starts_at',
      'ends_at',
      'all_day',
      'timezone',
      'recurrence',
      'recurrence_until',
      'recurrence_interval',
      'item_type',
      'completed_at',
      'not_needed_at',
      'notification_offsets',
      'is_pinned',
    ];
    const sets = [];
    const values = [];
    for (const key of allowed)
      if (key in changes) {
        sets.push(`${key}=?`);
        values.push(
          key === 'all_day' || key === 'is_pinned'
            ? booleanValue(changes[key])
            : key === 'notification_offsets'
              ? JSON.stringify(changes[key] || [])
              : (changes[key] ?? null),
        );
      }
    if (!sets.length) return;
    sets.push('updated_at=?');
    values.push(now(), id);
    this.db
      .prepare(`UPDATE calendar_sessions SET ${sets.join(',')} WHERE id=?`)
      .run(...values);
    this.syncTaskChecklistProgress(current.task_id);
    if ('task_id' in changes && changes.task_id !== current.task_id)
      this.syncTaskChecklistProgress(changes.task_id);
  }
  deleteCalendarSession(id) {
    const current = this.db
      .prepare('SELECT task_id FROM calendar_sessions WHERE id=?')
      .get(id);
    this.db.prepare('DELETE FROM calendar_sessions WHERE id=?').run(id);
    this.syncTaskChecklistProgress(current?.task_id);
  }
  updateCalendarOccurrence(calendarEntryId, input) {
    this.beginTransaction();
    try {
      this.updateCalendarOccurrenceNow(calendarEntryId, input);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  updateCalendarOccurrenceNow(calendarEntryId, input) {
    const session = this.db
      .prepare('SELECT id,task_id FROM calendar_sessions WHERE id=?')
      .get(calendarEntryId);
    if (!session) throw new Error('Calendar session not found.');
    const occurrenceStart = new Date(input.occurrence_start);
    if (Number.isNaN(occurrenceStart.getTime()))
      throw new Error('Occurrence time is invalid.');
    if (input.completed_at && input.not_needed_at)
      throw new Error('An occurrence cannot be done and not needed at once.');
    const currentState = this.db
      .prepare(
        'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=? AND occurrence_start=?',
      )
      .get(calendarEntryId, occurrenceStart.toISOString());
    this.db
      .prepare(
        `INSERT INTO calendar_occurrence_states
          (calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(calendar_entry_id,occurrence_start) DO UPDATE SET
          completed_at=excluded.completed_at,
          not_needed_at=excluded.not_needed_at,
          override_starts_at=excluded.override_starts_at,
          override_ends_at=excluded.override_ends_at,
          updated_at=excluded.updated_at`,
      )
      .run(
        calendarEntryId,
        occurrenceStart.toISOString(),
        'completed_at' in input
          ? nullableText(input.completed_at)
          : (currentState?.completed_at ?? null),
        'not_needed_at' in input
          ? nullableText(input.not_needed_at)
          : (currentState?.not_needed_at ?? null),
        'override_starts_at' in input
          ? nullableText(input.override_starts_at)
          : (currentState?.override_starts_at ?? null),
        'override_ends_at' in input
          ? nullableText(input.override_ends_at)
          : (currentState?.override_ends_at ?? null),
        now(),
      );
    this.syncTaskChecklistProgress(session.task_id);
  }
  moveCalendarOccurrences(calendarEntryId, changes) {
    if (!Array.isArray(changes) || !changes.length) return;
    const session = this.db
      .prepare('SELECT id FROM calendar_sessions WHERE id=?')
      .get(calendarEntryId);
    if (!session) throw new Error('Calendar session not found.');
    this.beginTransaction();
    try {
      const upsert = this.db.prepare(
        `INSERT INTO calendar_occurrence_states
          (calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at,updated_at)
         VALUES (?,?,NULL,NULL,?,?,?)
         ON CONFLICT(calendar_entry_id,occurrence_start) DO UPDATE SET
          override_starts_at=excluded.override_starts_at,
          override_ends_at=excluded.override_ends_at,
          updated_at=excluded.updated_at`,
      );
      for (const change of changes) {
        const original = new Date(change.occurrence_start);
        const nextStart = new Date(change.override_starts_at);
        const nextEnd = new Date(change.override_ends_at);
        if (
          Number.isNaN(original.getTime()) ||
          Number.isNaN(nextStart.getTime()) ||
          Number.isNaN(nextEnd.getTime()) ||
          nextEnd <= nextStart
        )
          throw new Error('Occurrence move is invalid.');
        upsert.run(
          calendarEntryId,
          original.toISOString(),
          nextStart.toISOString(),
          nextEnd.toISOString(),
          now(),
        );
      }
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  moveCalendarSeries(calendarEntryId, input) {
    const session = this.db
      .prepare('SELECT * FROM calendar_sessions WHERE id=?')
      .get(calendarEntryId);
    if (!session) throw new Error('Calendar session not found.');
    const originalStart = new Date(input.original_start);
    const originalEnd = new Date(input.original_end);
    const nextStart = new Date(input.next_start);
    let nextEnd = new Date(input.next_end);
    if (
      [originalStart, originalEnd, nextStart, nextEnd].some((date) =>
        Number.isNaN(date.getTime()),
      ) ||
      nextEnd <= nextStart
    )
      throw new Error('Series move is invalid.');
    if (session.item_type === 'reminder')
      nextEnd = new Date(nextStart.getTime() + 15 * 60_000);
    const deltaStart = nextStart.getTime() - originalStart.getTime();
    const deltaEnd = nextEnd.getTime() - originalEnd.getTime();
    const dayDelta =
      vietnamDayNumber(nextStart) - vietnamDayNumber(originalStart);
    const shiftedStart = new Date(
      new Date(session.starts_at).getTime() + deltaStart,
    );
    const states = this.db
      .prepare(
        'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=?',
      )
      .all(calendarEntryId);
    const mapping = states.map((state) => {
      const original = new Date(state.occurrence_start);
      let shifted = new Date(original.getTime() + deltaStart);
      if (session.recurrence === 'monthly') {
        const baseLocal = new Date(
            new Date(session.starts_at).getTime() + 7 * 3600000,
          ),
          stateLocal = new Date(original.getTime() + 7 * 3600000);
        const months =
          (stateLocal.getUTCFullYear() - baseLocal.getUTCFullYear()) * 12 +
          stateLocal.getUTCMonth() -
          baseLocal.getUTCMonth();
        if (
          months < 0 ||
          months % (session.recurrence_interval || 1) ||
          addVietnamMonths(session.starts_at, months).getTime() !==
            original.getTime()
        )
          throw new Error(
            'This monthly series contains an unmatched history date. Resolve it before moving the series.',
          );
        shifted = addVietnamMonths(shiftedStart, months);
      }
      const offset = shifted.getTime() - original.getTime();
      const start = state.override_starts_at
        ? new Date(
            new Date(state.override_starts_at).getTime() + offset,
          ).toISOString()
        : null;
      const end = state.override_ends_at
        ? new Date(
            new Date(state.override_ends_at).getTime() +
              offset +
              deltaEnd -
              deltaStart,
          ).toISOString()
        : null;
      for (const value of [shifted, start, end])
        validateDateYear(value, 'Moved date');
      return {
        old: state.occurrence_start,
        key: shifted.toISOString(),
        start,
        end,
      };
    });
    let nextUntil = shiftDateOnly(session.recurrence_until, dayDelta);
    if (session.recurrence === 'monthly' && session.recurrence_until) {
      let count = 0;
      const step = session.recurrence_interval || 1;
      while (
        count < 1000 &&
        vietnamDayNumber(
          addVietnamMonths(session.starts_at, (count + 1) * step),
        ) <= vietnamDayNumber(`${session.recurrence_until}T12:00:00+07:00`)
      )
        count++;
      const lastDay = vietnamDayNumber(
        addVietnamMonths(shiftedStart, count * step),
      );
      const nextDay = vietnamDayNumber(
        addVietnamMonths(shiftedStart, (count + 1) * step),
      );
      const requestedDay = vietnamDayNumber(`${nextUntil}T12:00:00+07:00`);
      nextUntil = new Date(
        Math.min(nextDay - 1, Math.max(lastDay, requestedDay)) * 86400000,
      )
        .toISOString()
        .slice(0, 10);
    }
    this.validateSession({
      ...session,
      starts_at: shiftedStart.toISOString(),
      ends_at: new Date(
        new Date(session.ends_at).getTime() + deltaEnd,
      ).toISOString(),
      recurrence_until: nextUntil,
    });
    this.beginTransaction();
    try {
      this.db
        .prepare(
          'UPDATE calendar_sessions SET starts_at=?,ends_at=?,recurrence_until=?,updated_at=? WHERE id=?',
        )
        .run(
          new Date(
            new Date(session.starts_at).getTime() + deltaStart,
          ).toISOString(),
          new Date(
            new Date(session.ends_at).getTime() + deltaEnd,
          ).toISOString(),
          nextUntil,
          now(),
          calendarEntryId,
        );
      this.db
        .prepare(
          "UPDATE calendar_occurrence_states SET occurrence_start='tmp:' || occurrence_start WHERE calendar_entry_id=?",
        )
        .run(calendarEntryId);
      for (const state of mapping)
        this.db
          .prepare(
            'UPDATE calendar_occurrence_states SET occurrence_start=?,override_starts_at=?,override_ends_at=?,updated_at=? WHERE calendar_entry_id=? AND occurrence_start=?',
          )
          .run(
            state.key,
            state.start,
            state.end,
            now(),
            calendarEntryId,
            `tmp:${state.old}`,
          );
      this.syncTaskChecklistProgress(session.task_id);
      this.commitTransaction();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }
  checklistOccurrenceSummary(taskId) {
    const sessions = this.db
      .prepare(
        "SELECT * FROM calendar_sessions WHERE task_id=? AND item_type='checklist'",
      )
      .all(taskId);
    const items = sessions.flatMap((session) =>
      expandSessionOccurrences(
        session,
        this.db
          .prepare(
            'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=?',
          )
          .all(session.id),
      ),
    );
    const completed = items.filter((item) => item.completed_at).length;
    const resolved = items.filter(
      (item) => item.completed_at || item.not_needed_at,
    ).length;
    return { total: items.length, completed, resolved };
  }
  syncTaskChecklistProgress(taskId) {
    if (!taskId) return;
    const { total, resolved } = this.checklistOccurrenceSummary(taskId);
    const done = total > 0 && resolved === total;
    const current = this.db
      .prepare(`SELECT t.workflow_status_id,t.previous_status_id,t.completed_at,s.category
        FROM tasks t JOIN workflow_statuses s ON s.id=t.workflow_status_id
        WHERE t.id=?`)
      .get(taskId);
    if (!current) return;
    const status = done
      ? this.db
          .prepare('SELECT id FROM workflow_statuses WHERE category=?')
          .get('completed')
      : current.category === 'completed'
        ? current.previous_status_id
          ? { id: current.previous_status_id }
          : this.db
              .prepare('SELECT id FROM workflow_statuses WHERE category=?')
              .get('planned')
        : { id: current.workflow_status_id };
    this.db
      .prepare(
        'UPDATE tasks SET progress=?,workflow_status_id=?,previous_status_id=?,completed_at=?,updated_at=? WHERE id=?',
      )
      .run(
        total ? Math.round((resolved * 100) / total) : 0,
        status.id,
        done && current.category !== 'completed'
          ? current.workflow_status_id
          : done
            ? current.previous_status_id
            : null,
        done ? (current.completed_at ?? now()) : null,
        now(),
        taskId,
      );
    const goalId = this.db
      .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
      .get(taskId)?.goal_id;
    this.syncGoalProgress(goalId);
  }
  getTimelineWorkspace() {
    return {
      statuses: this.listStatuses(),
      goals: this.listGoals('active'),
      tasks: this.db
        .prepare(
          `SELECT ${taskColumns} FROM tasks WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at,id`,
        )
        .all()
        .map((row) => {
          const task = this.normalizeTask(row);
          const summary = this.checklistOccurrenceSummary(row.id);
          return {
            ...task,
            active_checklist_count: summary.total,
            checklist_resolved_count: summary.resolved,
            checklist_done_count: summary.completed,
            progress: summary.total
              ? Math.round((summary.resolved * 100) / summary.total)
              : task.progress,
          };
        }),
      links: this.db
        .prepare('SELECT task_id,goal_id FROM task_goal_links')
        .all(),
      milestones: this.db
        .prepare(
          'SELECT id,goal_id,task_id,title,milestone_on FROM timeline_milestones ORDER BY milestone_on,id',
        )
        .all(),
    };
  }
  createTimelineMilestone(input) {
    validateDateYear(input.milestone_on, 'Milestone date');
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO timeline_milestones (id,goal_id,title,milestone_on,created_at,updated_at,task_id) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        nullableText(input.goal_id),
        requireText(input.title, 'Milestone title', 200),
        input.milestone_on,
        timestamp,
        timestamp,
        nullableText(input.task_id),
      );
    return id;
  }
  updateTimelineMilestone(id, changes) {
    const allowed = ['goal_id', 'task_id', 'title', 'milestone_on'];
    const sets = [];
    const values = [];
    for (const key of allowed)
      if (key in changes) {
        let value = changes[key];
        if (key === 'title') value = requireText(value, 'Milestone title', 200);
        if (key === 'milestone_on') validateDateYear(value, 'Milestone date');
        sets.push(`${key}=?`);
        values.push(value ?? null);
      }
    if (!sets.length) return;
    sets.push('updated_at=?');
    values.push(now(), id);
    this.db
      .prepare(`UPDATE timeline_milestones SET ${sets.join(',')} WHERE id=?`)
      .run(...values);
  }
  annotationColumn(kind) {
    const column = {
      task: 'task_id',
      calendar: 'calendar_entry_id',
      milestone: 'milestone_id',
    }[kind];
    if (!column) throw new Error('Invalid annotation target.');
    return column;
  }
  listAnnotations(target) {
    const column = this.annotationColumn(target.kind);
    return this.db
      .prepare(
        `SELECT id,kind,body,url,created_at,updated_at FROM planner_annotations WHERE ${column}=? ORDER BY created_at,id`,
      )
      .all(target.id);
  }
  saveAnnotation(target, input, id) {
    const column = this.annotationColumn(target.kind);
    if (!['comment', 'link'].includes(input.kind))
      throw new Error('Invalid annotation type.');
    const body = requireText(input.body, 'Comment or link label', 10000);
    const url =
      input.kind === 'link'
        ? validateHttpUrl(requireText(input.url, 'URL', 2048))
        : null;
    const timestamp = now();
    if (id)
      this.db
        .prepare(
          `UPDATE planner_annotations SET kind=?,body=?,url=?,updated_at=? WHERE id=? AND ${column}=?`,
        )
        .run(input.kind, body, url, timestamp, id, target.id);
    else
      this.db
        .prepare(
          `INSERT INTO planner_annotations(id,${column},kind,body,url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          target.id,
          input.kind,
          body,
          url,
          timestamp,
          timestamp,
        );
  }
  deleteAnnotation(id) {
    this.db.prepare('DELETE FROM planner_annotations WHERE id=?').run(id);
  }
  listHolidays() {
    return this.db
      .prepare(
        'SELECT id,title,starts_on,ends_on FROM planner_holidays ORDER BY starts_on,id',
      )
      .all();
  }
  saveHoliday(input, id) {
    const title = requireText(input.title, 'Holiday name', 200);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.starts_on ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.ends_on ?? '') ||
      input.ends_on < input.starts_on
    )
      throw new Error('Invalid holiday date range.');
    validateDateYear(input.starts_on, 'Holiday start');
    validateDateYear(input.ends_on, 'Holiday end');
    if (id)
      this.db
        .prepare(
          'UPDATE planner_holidays SET title=?,starts_on=?,ends_on=? WHERE id=?',
        )
        .run(title, input.starts_on, input.ends_on, id);
    else
      this.db
        .prepare(
          'INSERT INTO planner_holidays(id,title,starts_on,ends_on,created_at) VALUES(?,?,?,?,?)',
        )
        .run(randomUUID(), title, input.starts_on, input.ends_on, now());
  }
  deleteHoliday(id) {
    this.db.prepare('DELETE FROM planner_holidays WHERE id=?').run(id);
  }
  deleteTimelineMilestone(id) {
    this.db.prepare('DELETE FROM timeline_milestones WHERE id=?').run(id);
  }
  getTheme() {
    return (
      this.db.prepare("SELECT theme FROM app_settings WHERE id='local'").get()
        ?.theme || 'jade'
    );
  }
  saveTheme(theme) {
    if (!['jade', 'sapphire', 'ink', 'paper'].includes(theme))
      throw new Error('Invalid theme.');
    this.db
      .prepare("UPDATE app_settings SET theme=?,updated_at=? WHERE id='local'")
      .run(theme, now());
  }
  getPomodoroWorkspace() {
    const settings = this.db
      .prepare(
        "SELECT focus_minutes,short_break_minutes,long_break_minutes,daily_target_type,daily_target_value FROM pomodoro_settings WHERE id='local'",
      )
      .get();
    const sessions = this.db
      .prepare(
        'SELECT id,started_at,completed_at,duration_minutes FROM pomodoro_sessions ORDER BY completed_at DESC,id',
      )
      .all();
    return { settings, sessions };
  }
  savePomodoroSettings(input) {
    for (const key of [
      'focus_minutes',
      'short_break_minutes',
      'long_break_minutes',
      'daily_target_value',
    ])
      if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 240)
        throw new Error('Pomodoro values must be between 1 and 240.');
    if (!['sessions', 'minutes'].includes(input.daily_target_type))
      throw new Error('Invalid target type.');
    this.db
      .prepare(
        "UPDATE pomodoro_settings SET focus_minutes=?,short_break_minutes=?,long_break_minutes=?,daily_target_type=?,daily_target_value=?,updated_at=? WHERE id='local'",
      )
      .run(
        input.focus_minutes,
        input.short_break_minutes,
        input.long_break_minutes,
        input.daily_target_type,
        input.daily_target_value,
        now(),
      );
  }
  recordPomodoroSession(input) {
    if (!Number.isInteger(input.duration_minutes) || input.duration_minutes < 1)
      throw new Error('Completed focus duration is invalid.');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pomodoro_sessions (id,client_id,started_at,completed_at,duration_minutes,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        input.client_id ?? null,
        input.started_at,
        input.completed_at,
        input.duration_minutes,
        now(),
      );
  }
  getReviewsWorkspace(a, b) {
    return {
      reviews: this.db
        .prepare(
          'SELECT id,week_start,wins,challenges,next_week_focus,satisfaction,updated_at FROM weekly_reviews ORDER BY week_start DESC,id',
        )
        .all(),
      stats: {
        completedTasks: Number(
          this.db
            .prepare(
              'SELECT count(*) count FROM tasks WHERE completed_at>=? AND completed_at<? AND deleted_at IS NULL',
            )
            .get(a, b).count,
        ),
        openTasks: Number(
          this.db
            .prepare(
              'SELECT count(*) count FROM tasks WHERE completed_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL',
            )
            .get().count,
        ),
        activeGoals: Number(
          this.db
            .prepare(
              "SELECT count(*) count FROM goals WHERE status='active' AND archived_at IS NULL AND deleted_at IS NULL",
            )
            .get().count,
        ),
      },
    };
  }
  saveWeeklyReview(input) {
    if (
      input.satisfaction !== null &&
      input.satisfaction !== undefined &&
      (!Number.isInteger(input.satisfaction) ||
        input.satisfaction < 1 ||
        input.satisfaction > 5)
    )
      throw new Error('Satisfaction must be between 1 and 5.');
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO weekly_reviews (id,week_start,wins,challenges,next_week_focus,satisfaction,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(week_start) DO UPDATE SET wins=excluded.wins,challenges=excluded.challenges,next_week_focus=excluded.next_week_focus,satisfaction=excluded.satisfaction,updated_at=excluded.updated_at',
      )
      .run(
        randomUUID(),
        input.week_start,
        input.wins || '',
        input.challenges || '',
        input.next_week_focus || '',
        input.satisfaction ?? null,
        timestamp,
        timestamp,
      );
  }
}
