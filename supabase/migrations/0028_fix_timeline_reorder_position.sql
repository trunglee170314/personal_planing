-- Avoid colliding with the legacy public.tasks.position column. Keep the
-- existing reorder contract, ownership checks, lock and group-move behavior.
begin;

create or replace function public.myplan_reorder_timeline(
  target_kind text,
  target_id uuid,
  target_goal uuid default null,
  before_id uuid default null
) returns void language plpgsql security definer set search_path='' as $$
declare
  task_row public.tasks;
  item record;
  v_sort_order bigint := 0;
  target_parent uuid;
  effective_before uuid;
begin
  if auth.uid() is null or not public.myplan_is_approved() then
    raise exception 'Approved account required.';
  end if;
  if target_kind not in ('goal','task') then
    raise exception 'Invalid timeline reorder.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  if target_kind='goal' then
    if not exists(
      select 1 from public.goals g where g.id=target_id and g.user_id=auth.uid()
        and g.status<>'archived' and g.deleted_at is null for update
    ) then raise exception 'Goal not found.'; end if;
    for item in
      select ordered.id from (
        select g.id,g.sort_order,g.created_at from public.goals g
          where g.user_id=auth.uid() and g.status<>'archived'
            and g.deleted_at is null and g.id<>target_id
        union all
        select target_id,coalesce((select g.sort_order-1 from public.goals g
          where g.id=before_id and g.user_id=auth.uid()),9223372036854775806),now()
      ) ordered order by ordered.sort_order nulls last,ordered.created_at,ordered.id
    loop
      v_sort_order := v_sort_order+1024;
      update public.goals g set sort_order=v_sort_order
        where g.id=item.id and g.user_id=auth.uid();
    end loop;
  else
    select t.* into task_row from public.tasks t
      where t.id=target_id and t.user_id=auth.uid()
        and t.archived_at is null and t.deleted_at is null for update;
    if not found then raise exception 'Task not found.'; end if;
    if target_goal is not null and not exists(
      select 1 from public.goals g where g.id=target_goal and g.user_id=auth.uid()
        and g.status<>'archived' and g.deleted_at is null
    ) then raise exception 'Target Goal is not active.'; end if;
    if target_goal is distinct from task_row.goal_id then
      -- Only the dragged Task changes group; descendants remain in the old Goal.
      update public.tasks t set parent_task_id=null
        where t.parent_task_id=target_id and t.user_id=auth.uid();
      update public.tasks t set goal_id=target_goal,parent_task_id=null
        where t.id=target_id and t.user_id=auth.uid();
    end if;
    target_parent := case when target_goal is distinct from task_row.goal_id
      then null else task_row.parent_task_id end;
    select t.id into effective_before from public.tasks t
      where t.id=before_id and t.user_id=auth.uid()
        and t.goal_id is not distinct from target_goal
        and t.parent_task_id is not distinct from target_parent;
    v_sort_order := 0;
    for item in
      select ordered.id from (
        select t.id,t.sort_order,t.created_at from public.tasks t
          where t.user_id=auth.uid() and t.archived_at is null and t.deleted_at is null
            and t.goal_id is not distinct from target_goal
            and t.parent_task_id is not distinct from target_parent and t.id<>target_id
        union all
        select target_id,coalesce((select t.sort_order-1 from public.tasks t
          where t.id=effective_before and t.user_id=auth.uid()),9223372036854775806),now()
      ) ordered order by ordered.sort_order nulls last,ordered.created_at,ordered.id
    loop
      v_sort_order := v_sort_order+1024;
      update public.tasks t set sort_order=v_sort_order
        where t.id=item.id and t.user_id=auth.uid();
    end loop;
  end if;
end $$;
revoke all on function public.myplan_reorder_timeline(text,uuid,uuid,uuid) from public,anon;
grant execute on function public.myplan_reorder_timeline(text,uuid,uuid,uuid) to authenticated;

notify pgrst,'reload schema';
commit;
