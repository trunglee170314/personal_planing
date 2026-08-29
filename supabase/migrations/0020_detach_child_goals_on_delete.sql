-- Preserve child Goals when permanently deleting their parent. Early cloud
-- schemas used either parent_goal_id or parent_id for the hierarchy link.

create or replace function public.delete_myplan_goal(target_goal_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  parent_column text;
  owner_column text;
begin
  if not exists (
    select 1 from public.goals
    where id=target_goal_id and user_id=auth.uid()
    for update
  ) then
    raise exception 'Goal not found.';
  end if;

  parent_column := case
    when exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='goals'
        and column_name='parent_goal_id'
    ) then 'parent_goal_id'
    when exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='goals'
        and column_name='parent_id'
    ) then 'parent_id'
    else null
  end;
  owner_column := case
    when exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='goals'
        and column_name='user_id'
    ) then 'user_id'
    when exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='goals'
        and column_name='owner_user_id'
    ) then 'owner_user_id'
    else null
  end;

  if parent_column is not null then
    if owner_column is null then
      raise exception 'Goals owner column was not found.';
    end if;
    execute pg_catalog.format(
      'update public.goals set %1$I=null where %1$I=$1 and %2$I=$2',
      parent_column,
      owner_column
    ) using target_goal_id, auth.uid();
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

notify pgrst, 'reload schema';
