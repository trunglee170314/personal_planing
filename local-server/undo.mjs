import { AsyncLocalStorage } from 'node:async_hooks';
export const undoContext = new AsyncLocalStorage();
const tables = [
  'goals',
  'tasks',
  'task_goal_links',
  'calendar_sessions',
  'calendar_occurrence_states',
  'timeline_milestones',
];
const ignored = new Set(['created_at', 'updated_at']);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export function installLocalUndo(database) {
  const db = database.db;
  const history = new Map();
  let sequence = 0;
  db.function('myplan_capture_undo', (table, beforeText, afterText) => {
    const context = undoContext.getStore();
    if (
      !context ||
      context.replaying ||
      !uuid.test(context.operation ?? '') ||
      !uuid.test(context.session ?? '')
    )
      return null;
    const before = beforeText ? JSON.parse(beforeText) : null;
    const after = afterText ? JSON.parse(afterText) : null;
    const row = after ?? before;
    const key =
      table === 'calendar_occurrence_states'
        ? {
            calendar_entry_id: row.calendar_entry_id,
            occurrence_start: row.occurrence_start,
          }
        : table === 'task_goal_links'
          ? { task_id: row.task_id, goal_id: row.goal_id }
          : { id: row.id };
    const commandKey = `${context.session}:${context.operation}`;
    let command = history.get(commandKey);
    if (!command) {
      command = {
        created: Date.now(),
        rows: new Map(),
        bytes: 0,
        unavailable: false,
      };
      history.set(commandKey, command);
    }
    if (command.unavailable) return null;
    const rowKey = `${table}:${JSON.stringify(key)}`;
    const beforeKey =
      before && table === 'calendar_occurrence_states'
        ? `${table}:${JSON.stringify({ calendar_entry_id: before.calendar_entry_id, occurrence_start: before.occurrence_start })}`
        : rowKey;
    const previous = command.rows.get(beforeKey) ?? command.rows.get(rowKey);
    if (beforeKey !== rowKey) command.rows.delete(beforeKey);
    command.rows.set(rowKey, {
      table,
      key,
      before: previous ? previous.before : before,
      after,
      sequence: previous?.sequence ?? sequence++,
    });
    command.bytes = Buffer.byteLength(
      JSON.stringify([...command.rows.values()]),
    );
    // Never retain only a portion of a large operation: that would make Undo
    // restore half a group. Keep a bounded unavailable marker instead.
    if (command.rows.size > 2000 || command.bytes > 1024 * 1024) {
      command.rows.clear();
      command.bytes = 0;
      command.unavailable = true;
    }
    // Whole-command retention, at most 2 MiB across all local browser sessions.
    for (const [key, value] of history)
      if (Date.now() - value.created > 86400000) history.delete(key);
    while (
      history.size > 20 ||
      [...history.values()].reduce((sum, item) => sum + item.bytes, 0) >
        2 * 1024 * 1024
    ) {
      const oldest = [...history.keys()].find((key) => key !== commandKey);
      if (!oldest) break;
      history.delete(oldest);
    }
    return null;
  });
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name);
    const payload = (prefix) =>
      `json_object(${columns.map((column) => `'${column}',${prefix}."${column}"`).join(',')})`;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
      db.exec(
        `CREATE TEMP TRIGGER capture_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN SELECT myplan_capture_undo('${table}',${operation === 'INSERT' ? 'NULL' : payload('old')},${operation === 'DELETE' ? 'NULL' : payload('new')}); END;`,
      );
  }
  function commandFor(operation, session) {
    const key = `${session}:${operation}`;
    const command = history.get(key);
    if (command && Date.now() - command.created > 86400000) {
      history.delete(key);
      return null;
    }
    return command;
  }
  database.undoReady = (operation, session) =>
    Boolean(commandFor(operation, session)?.rows.size);
  database.applyUndo = (operation, session) => {
    const command = commandFor(operation, session);
    if (!command || command.unavailable)
      throw new Error('Undo is no longer available.');
    const receipts = [...command.rows.values()].map((receipt) => ({
      ...receipt,
      key: { ...receipt.key },
    }));
    const checklistTasks = new Set();
    for (const receipt of receipts) {
      if (receipt.table === 'calendar_sessions')
        for (const row of [receipt.before, receipt.after])
          if (row?.item_type === 'checklist' && row.task_id)
            checklistTasks.add(row.task_id);
      if (receipt.table === 'calendar_occurrence_states') {
        const entry = db
          .prepare('SELECT task_id,item_type FROM calendar_sessions WHERE id=?')
          .get(receipt.key.calendar_entry_id);
        if (entry?.item_type === 'checklist' && entry.task_id)
          checklistTasks.add(entry.task_id);
      }
    }
    const where = (receipt) =>
      Object.keys(receipt.key)
        .map((column) => `"${column}"=?`)
        .join(' AND ');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const receipt of receipts) {
        const current = db
          .prepare(`SELECT * FROM ${receipt.table} WHERE ${where(receipt)}`)
          .get(...Object.values(receipt.key));
        if (!receipt.after) {
          if (current)
            throw new Error('Undo conflict: this record was recreated.');
          continue;
        }
        if (!current)
          throw new Error('Undo conflict: this record was removed.');
        for (const column of Object.keys(receipt.after)) {
          if (ignored.has(column)) continue;
          if (
            !receipt.before ||
            receipt.before[column] !== receipt.after[column]
          )
            if (current[column] !== receipt.after[column])
              throw new Error(
                'Undo conflict: this item has changed since your action.',
              );
        }
      }
      undoContext.run({ replaying: true }, () => {
        // Reverse series shifts through a disjoint temporary keyspace to avoid
        // collisions when the destination was another occurrence's old date.
        for (const receipt of receipts) {
          if (
            receipt.table !== 'calendar_occurrence_states' ||
            !receipt.before ||
            !receipt.after ||
            receipt.before.occurrence_start === receipt.after.occurrence_start
          )
            continue;
          const temporary = new Date(receipt.after.occurrence_start);
          temporary.setUTCFullYear(temporary.getUTCFullYear() + 2000);
          db.prepare(
            `UPDATE calendar_occurrence_states SET occurrence_start=? WHERE ${where(receipt)}`,
          ).run(temporary.toISOString(), ...Object.values(receipt.key));
          receipt.key.occurrence_start = temporary.toISOString();
        }
        for (const receipt of receipts.sort(
          (a, b) => b.sequence - a.sequence,
        )) {
          if (!receipt.before) {
            if (!receipt.after) continue;
            if (
              !['calendar_occurrence_states', 'task_goal_links'].includes(
                receipt.table,
              )
            )
              throw new Error(
                'Undo creation is not supported for this action.',
              );
            db.prepare(
              `DELETE FROM ${receipt.table} WHERE ${where(receipt)}`,
            ).run(...Object.values(receipt.key));
          } else if (!receipt.after) {
            if (
              !['calendar_occurrence_states', 'task_goal_links'].includes(
                receipt.table,
              )
            )
              throw new Error('Permanent deletion cannot be undone.');
            const columns = Object.keys(receipt.before);
            db.prepare(
              `INSERT INTO ${receipt.table} (${columns.map((column) => `"${column}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
            ).run(...Object.values(receipt.before));
          } else {
            const columns = Object.keys(receipt.before).filter(
              (column) =>
                !ignored.has(column) &&
                column !== 'id' &&
                receipt.before[column] !== receipt.after[column],
            );
            if (columns.length)
              db.prepare(
                `UPDATE ${receipt.table} SET ${columns.map((column) => `"${column}"=?`).join(',')} WHERE ${where(receipt)}`,
              ).run(
                ...columns.map((column) => receipt.before[column]),
                ...Object.values(receipt.key),
              );
          }
        }
        for (const receipt of receipts.filter(
          (item) => item.table === 'tasks',
        )) {
          const task = db
            .prepare('SELECT id,parent_task_id FROM tasks WHERE id=?')
            .get(receipt.key.id);
          if (task)
            database.validateTaskHierarchy(
              task.id,
              task.parent_task_id,
              db
                .prepare('SELECT goal_id FROM task_goal_links WHERE task_id=?')
                .get(task.id)?.goal_id,
            );
          if (task && database.checklistOccurrenceSummary(task.id).total > 0)
            checklistTasks.add(task.id);
        }
        // Child membership may have changed without changing the old percent.
        // Derive aggregates from current children, never from a stale receipt.
        for (const taskId of checklistTasks)
          database.syncTaskChecklistProgress(taskId);
        for (const receipt of receipts)
          if (receipt.table === 'goals')
            database.syncGoalProgress(receipt.key.id);
      });
      db.exec('COMMIT');
      history.delete(`${session}:${operation}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
}
