-- Keep each goal's progress and completion status derived from its active tasks.
-- Only leaf tasks count, so a parent task and its subtasks are not double-counted.
-- Cancelled, archived and trashed tasks do not contribute to the calculation.

create or replace function public.apply_myplan_goal_task_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  total_tasks integer;
  completed_tasks integer;
begin
  if new.status = 'archived' or new.deleted_at is not null then
    return new;
  end if;

  with eligible as (
    select task.id, task.parent_task_id, task.status
    from public.tasks as task
    where task.goal_id = new.id
      and task.archived_at is null
      and task.deleted_at is null
      and task.status <> 'cancelled'
  ), leaves as (
    select task.*
    from eligible as task
    where not exists (
      select 1 from eligible as child where child.parent_task_id = task.id
    )
  )
  select count(*), count(*) filter (where status = 'completed')
  into total_tasks, completed_tasks
  from leaves;

  if total_tasks > 0 then
    new.progress := round(completed_tasks * 100.0 / total_tasks)::smallint;
    new.status := case
      when completed_tasks = total_tasks then 'completed'
      else 'active'
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists goals_apply_task_progress on public.goals;
create trigger goals_apply_task_progress
before insert or update of progress, status, deleted_at on public.goals
for each row execute function public.apply_myplan_goal_task_progress();

create or replace function public.sync_myplan_task_goal_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_goal_id uuid;
  next_goal_id uuid;
begin
  if tg_op <> 'INSERT' then
    previous_goal_id := old.goal_id;
  end if;
  if tg_op <> 'DELETE' then
    next_goal_id := new.goal_id;
  end if;

  if previous_goal_id is not null then
    update public.goals set progress = progress where id = previous_goal_id;
  end if;
  if next_goal_id is not null and next_goal_id is distinct from previous_goal_id then
    update public.goals set progress = progress where id = next_goal_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_sync_goal_progress on public.tasks;
create trigger tasks_sync_goal_progress
after insert or delete or update of goal_id, status, parent_task_id, archived_at, deleted_at
on public.tasks
for each row execute function public.sync_myplan_task_goal_progress();

-- Backfill all existing non-archived goals through the new BEFORE trigger.
update public.goals
set progress = progress
where status <> 'archived' and deleted_at is null;
