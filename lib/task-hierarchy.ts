export function descendantIds(
  tasks: Array<{ id: string; parent_task_id: string | null }>,
  id?: string,
) {
  const found = new Set<string>();
  if (!id) return found;
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop()!;
    if (found.has(parent)) continue;
    found.add(parent);
    for (const task of tasks)
      if (task.parent_task_id === parent) pending.push(task.id);
  }
  return found;
}
