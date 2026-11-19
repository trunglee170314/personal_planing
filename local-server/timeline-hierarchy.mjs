import { createHash } from 'node:crypto';

function snapshot(database) {
  const tasks = database.db
    .prepare(
      'SELECT * FROM tasks WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY id',
    )
    .all();
  const links = database.db
    .prepare(
      `SELECT l.task_id,l.goal_id FROM task_goal_links l JOIN tasks t ON t.id=l.task_id WHERE t.archived_at IS NULL AND t.deleted_at IS NULL ORDER BY l.task_id,l.goal_id`,
    )
    .all();
  const goals = new Map();
  for (const link of links) {
    if (goals.has(link.task_id))
      throw new Error(
        'A Task has multiple Goal links. Resolve its Goal before rearranging the Timeline.',
      );
    goals.set(link.task_id, link.goal_id);
  }
  const tree = tasks.map((task) => ({
    id: task.id,
    parent_task_id: task.parent_task_id ?? null,
    goal_id: goals.get(task.id) ?? null,
    sort_order: task.sort_order ?? null,
  }));
  return {
    tasks,
    goals,
    tree,
    version: createHash('sha256')
      .update(JSON.stringify({ tasks, links }))
      .digest('hex'),
  };
}

function activeGoal(database, goalId) {
  if (goalId === null) return;
  const goal = database.db
    .prepare('SELECT status,archived_at,deleted_at FROM goals WHERE id=?')
    .get(goalId);
  if (
    !goal ||
    goal.status === 'archived' ||
    goal.archived_at ||
    goal.deleted_at
  )
    throw new Error(
      'The Task Goal is unavailable. Restore or reassign it before rearranging the Timeline.',
    );
}

export function previewTimelineHierarchy(database, taskId) {
  if (typeof taskId !== 'string' || !taskId)
    throw new Error('Task is required.');
  const current = snapshot(database);
  if (!current.tasks.some((task) => task.id === taskId))
    throw new Error('Task not found.');
  activeGoal(database, current.goals.get(taskId) ?? null);
  return { version: current.version, tree: current.tree };
}

const siblingOrder = (a, b) =>
  (a.sort_order === null || a.sort_order === undefined) -
    (b.sort_order === null || b.sort_order === undefined) ||
  (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
  a.created_at.localeCompare(b.created_at) ||
  a.id.localeCompare(b.id);

/** Reparent only the dragged root. Its complete subtree retains its identities,
 * dates, metadata, notes and milestones. One transaction produces one Undo. */
export function restructureTimeline(database, input) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.task_id !== 'string' ||
    !input.task_id ||
    !['task', 'goal'].includes(input.target_kind) ||
    !['inside', 'before', 'after'].includes(input.placement) ||
    typeof input.expected_version !== 'string' ||
    !input.expected_version ||
    !(
      input.target_id === null ||
      (typeof input.target_id === 'string' && input.target_id)
    )
  )
    throw new Error('Invalid Timeline hierarchy change.');
  if (input.target_kind === 'task' && input.target_id === null)
    throw new Error('Target Task is required.');
  if (input.target_kind === 'goal' && input.placement !== 'inside')
    throw new Error('Drop inside a Goal to move to its root.');
  database.beginTransaction();
  try {
    const current = snapshot(database);
    if (current.version !== input.expected_version)
      throw new Error(
        'This Timeline changed. Refresh and drag the Task again.',
      );
    const source = current.tasks.find((task) => task.id === input.task_id);
    if (!source) throw new Error('Task not found.');
    const sourceGoal = current.goals.get(source.id) ?? null;
    activeGoal(database, sourceGoal);
    let parent = null;
    let target = null;
    if (input.target_kind === 'goal') {
      activeGoal(database, input.target_id);
      if (input.target_id !== sourceGoal)
        throw new Error('Move Tasks within the same Goal.');
    } else {
      target = current.tasks.find((task) => task.id === input.target_id);
      if (!target) throw new Error('Target Task not found.');
      if (source.id === target.id)
        throw new Error('A Task cannot be dropped on itself.');
      if ((current.goals.get(target.id) ?? null) !== sourceGoal)
        throw new Error('Move Tasks within the same Goal.');
      parent =
        input.placement === 'inside'
          ? target.id
          : (target.parent_task_id ?? null);
    }
    // Hiding a descendant cannot make the destination safe. Every ancestor must
    // remain active and in the same raw Goal; legacy damaged chains need repair.
    const allTasks = new Map(current.tasks.map((task) => [task.id, task]));
    const seen = new Set([source.id]);
    let ancestor = parent;
    while (ancestor) {
      if (seen.has(ancestor))
        throw new Error(
          'A Task cannot be moved inside its own subtree or a cyclic hierarchy.',
        );
      seen.add(ancestor);
      const row = allTasks.get(ancestor);
      if (!row || (current.goals.get(row.id) ?? null) !== sourceGoal)
        throw new Error('This Task hierarchy needs repair before moving it.');
      ancestor = row.parent_task_id;
    }
    const siblings = current.tasks
      .filter(
        (task) =>
          task.id !== source.id &&
          (task.parent_task_id ?? null) === parent &&
          (current.goals.get(task.id) ?? null) === sourceGoal,
      )
      .sort(siblingOrder);
    let at = siblings.length;
    if (target && input.placement !== 'inside') {
      const targetAt = siblings.findIndex((task) => task.id === target.id);
      if (targetAt < 0)
        throw new Error(
          'Target sibling position changed. Refresh the Timeline.',
        );
      at = targetAt + (input.placement === 'after' ? 1 : 0);
    }
    siblings.splice(at, 0, source);
    const sourceOrder = siblings.findIndex((task) => task.id === source.id);
    const originalSiblings = current.tasks
      .filter(
        (task) =>
          (task.parent_task_id ?? null) === parent &&
          (current.goals.get(task.id) ?? null) === sourceGoal,
      )
      .sort(siblingOrder);
    if (
      (source.parent_task_id ?? null) === parent &&
      originalSiblings.length === siblings.length &&
      originalSiblings.every((task, i) => task.id === siblings[i].id)
    )
      throw new Error('Task is already in this position.');
    const updatedAt = new Date().toISOString();
    database.db
      .prepare(
        'UPDATE tasks SET parent_task_id=?,sort_order=?,updated_at=? WHERE id=?',
      )
      .run(parent, (sourceOrder + 1) * 1024, updatedAt, source.id);
    const order = database.db.prepare(
      'UPDATE tasks SET sort_order=?,updated_at=? WHERE id=?',
    );
    siblings.forEach((task, i) => {
      const next = (i + 1) * 1024;
      if (task.id !== source.id && task.sort_order !== next)
        order.run(next, updatedAt, task.id);
    });
    database.syncGoalProgress(sourceGoal);
    database.commitTransaction();
  } catch (error) {
    database.rollbackTransaction();
    throw error;
  }
}
