import { createHash } from 'node:crypto';
const dayMs = 86400000;
function shifted(value, days) {
  if (!value) return null;
  const next = new Date(new Date(value).getTime() + days * dayMs).toISOString();
  if (next < '2000-01-01' || next >= '2201-01-01')
    throw new Error('Moved dates must stay between 2000 and 2200.');
  return value.length === 10 ? next.slice(0, 10) : next;
}
function validDays(days) {
  if (!Number.isInteger(days) || Math.abs(days) > 73000)
    throw new Error('Invalid day offset.');
}
export function timelineGroupSnapshot(database, goalId) {
  const db = database.db,
    goal = db
      .prepare(
        "SELECT * FROM goals WHERE id=? AND status<>'archived' AND deleted_at IS NULL",
      )
      .get(goalId);
  if (!goal) throw new Error('Goal not found.');
  const tasks = db
    .prepare(
      'SELECT t.* FROM tasks t JOIN task_goal_links l ON l.task_id=t.id WHERE l.goal_id=? AND t.archived_at IS NULL AND t.deleted_at IS NULL ORDER BY t.id',
    )
    .all(goalId);
  const ids = new Set(tasks.map((task) => task.id));
  const milestones = db
    .prepare('SELECT * FROM timeline_milestones ORDER BY id')
    .all()
    .filter((item) => item.goal_id === goalId || ids.has(item.task_id));
  const entries = db
    .prepare('SELECT * FROM calendar_sessions ORDER BY id')
    .all()
    .filter((item) => ids.has(item.task_id));
  const entryIds = new Set(entries.map((entry) => entry.id));
  const states = db
    .prepare(
      'SELECT * FROM calendar_occurrence_states ORDER BY calendar_entry_id,occurrence_start',
    )
    .all()
    .filter((item) => entryIds.has(item.calendar_entry_id));
  return { goal, tasks, milestones, entries, states };
}
const signature = (snapshot) =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export function timelineGroupPlan(database, goalId) {
  const snapshot = timelineGroupSnapshot(database, goalId);
  return {
    version: signature(snapshot),
    tasks: snapshot.tasks.length,
    milestones: snapshot.milestones.length,
    calendar: snapshot.entries.length,
  };
}
export function moveTimelineGroup(database, goalId, days, version) {
  validDays(days);
  database.beginTransaction();
  try {
    const snapshot = timelineGroupSnapshot(database, goalId);
    if (signature(snapshot) !== version)
      throw new Error(
        'This group changed. Review the affected items again before moving it.',
      );
    const { goal, tasks, milestones, entries, states } = snapshot;
    // Validate all recurrence exceptions/horizons too, before any write.
    for (const state of states)
      for (const field of [
        'occurrence_start',
        'override_starts_at',
        'override_ends_at',
      ])
        shifted(state[field], days);
    for (const entry of entries) shifted(entry.recurrence_until, days);
    database.updateGoal(goalId, {
      starts_on: shifted(goal.starts_on, days),
      ends_on: shifted(goal.ends_on, days),
    });
    for (const task of tasks)
      database.updateTask(task.id, {
        planned_start: shifted(task.planned_start, days),
        planned_end: shifted(task.planned_end, days),
        due_at: shifted(task.due_at, days),
      });
    for (const milestone of milestones)
      database.updateTimelineMilestone(milestone.id, {
        milestone_on: shifted(milestone.milestone_on, days),
      });
    for (const entry of entries)
      database.moveCalendarSeries(entry.id, {
        original_start: entry.starts_at,
        original_end: entry.ends_at,
        next_start: shifted(entry.starts_at, days),
        next_end: shifted(entry.ends_at, days),
      });
    database.commitTransaction();
  } catch (error) {
    database.rollbackTransaction();
    throw error;
  }
}
export function moveTimelineTask(database, id, input) {
  validDays(input.days);
  database.beginTransaction();
  try {
    const current = database.db
      .prepare(
        'SELECT * FROM tasks WHERE id=? AND archived_at IS NULL AND deleted_at IS NULL',
      )
      .get(id);
    if (!current) throw new Error('Task not found.');
    const oldGoal =
      database.db
        .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
        .get(id)?.goal_id ?? null;
    if (
      oldGoal !== input.expected_goal ||
      (current.parent_task_id ?? null) !== input.expected_parent ||
      current.planned_start !== input.expected_start ||
      current.due_at !== input.expected_due
    )
      throw new Error(
        'This task changed. Reload its schedule before moving it.',
      );
    const reparent = input.goal_id !== oldGoal;
    if (
      reparent &&
      input.goal_id &&
      !database.db
        .prepare(
          "SELECT id FROM goals WHERE id=? AND status<>'archived' AND deleted_at IS NULL",
        )
        .get(input.goal_id)
    )
      throw new Error('Target Goal is not active.');
    if (reparent) {
      for (const child of database.db
        .prepare('SELECT id FROM tasks WHERE parent_task_id=?')
        .all(id))
        database.updateTask(child.id, {
          parent_task_id: current.parent_task_id,
        });
    }
    database.updateTask(id, {
      planned_start: shifted(current.planned_start, input.days),
      planned_end: shifted(current.planned_end, input.days),
      due_at: shifted(current.due_at, input.days),
      ...(reparent ? { goal_id: input.goal_id, parent_task_id: null } : {}),
    });
    database.commitTransaction();
  } catch (error) {
    database.rollbackTransaction();
    throw error;
  }
}
