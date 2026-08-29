-- Preserve legacy calendar rows when their linked Goal or Task is permanently
-- deleted. New installations use calendar_entries, but early production
-- databases can still contain time_blocks with restrictive foreign keys.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='time_blocks'
      and column_name='task_id'
  ) then
    alter table public.time_blocks alter column task_id drop not null;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='time_blocks'
      and column_name='goal_id'
  ) then
    alter table public.time_blocks alter column goal_id drop not null;
  end if;
end;
$$;

create or replace function public.detach_legacy_time_blocks(
  target_column text,
  target_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_column text;
begin
  if target_column not in ('task_id','goal_id') then
    raise exception 'Unsupported legacy time block link.';
  end if;
  if pg_catalog.to_regclass('public.time_blocks') is null or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='time_blocks'
      and column_name=target_column
  ) then
    return;
  end if;

  owner_column := case
    when exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='time_blocks'
        and column_name='user_id'
    ) then 'user_id'
    when exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='time_blocks'
        and column_name='owner_user_id'
    ) then 'owner_user_id'
    else null
  end;

  if owner_column is null then
    raise exception 'Legacy time_blocks owner column was not found.';
  end if;
  execute pg_catalog.format(
    'update public.time_blocks set %1$I=null where %1$I=$1 and %2$I=$2',
    target_column,
    owner_column
  ) using target_id, auth.uid();
end;
$$;

revoke all on function public.detach_legacy_time_blocks(text,uuid) from public;
grant execute on function public.detach_legacy_time_blocks(text,uuid) to authenticated;

create or replace function public.delete_myplan_goal(target_goal_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.goals
    where id=target_goal_id and user_id=auth.uid()
    for update
  ) then
    raise exception 'Goal not found.';
  end if;

  update public.tasks set goal_id=null
    where goal_id=target_goal_id and user_id=auth.uid();
  perform public.detach_legacy_time_blocks('goal_id',target_goal_id);
  delete from public.goals
    where id=target_goal_id and user_id=auth.uid();
end;
$$;

revoke all on function public.delete_myplan_goal(uuid) from public;
grant execute on function public.delete_myplan_goal(uuid) to authenticated;

create or replace function public.delete_myplan_task(target_task_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.tasks
    where id=target_task_id and user_id=auth.uid()
    for update
  ) then
    raise exception 'Task not found.';
  end if;

  update public.tasks set parent_task_id=null
    where parent_task_id=target_task_id and user_id=auth.uid();
  update public.tasks set dependency_task_id=null
    where dependency_task_id=target_task_id and user_id=auth.uid();
  update public.calendar_entries
    set task_id=null,item_type='reminder',ends_at=starts_at+interval '15 minutes'
    where task_id=target_task_id and owner_user_id=auth.uid();
  perform public.detach_legacy_time_blocks('task_id',target_task_id);
  delete from public.tasks
    where id=target_task_id and user_id=auth.uid();
end;
$$;

revoke all on function public.delete_myplan_task(uuid) from public;
grant execute on function public.delete_myplan_task(uuid) to authenticated;

notify pgrst, 'reload schema';
