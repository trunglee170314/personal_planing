-- Hierarchy gestures are separate from schedule/group moves: only the dragged
-- root's parent and destination sibling order change. Descendants stay attached.
begin;

create function myplan_private.timeline_hierarchy_version() returns text
language sql security definer set search_path='' as $$
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text)
  from public.tasks t where t.user_id=auth.uid()
    and t.archived_at is null and t.deleted_at is null;
$$;
revoke all on function myplan_private.timeline_hierarchy_version() from public,anon,authenticated;

create function public.myplan_preview_timeline_hierarchy(target_task uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.myplan_is_approved() then
    raise exception 'Approved account required.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  if not exists(select 1 from public.tasks t where t.id=target_task
      and t.user_id=auth.uid() and t.archived_at is null and t.deleted_at is null) then
    raise exception 'Task not found.';
  end if;
  if exists(select 1 from public.tasks t where t.id=target_task and t.goal_id is not null
    and not exists(select 1 from public.goals g where g.id=t.goal_id and g.user_id=auth.uid()
      and g.status<>'archived' and g.deleted_at is null)) then
    raise exception 'Task Goal is not active.';
  end if;
  return jsonb_build_object('version',myplan_private.timeline_hierarchy_version(),
    'tree',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,
      'parent_task_id',t.parent_task_id,'goal_id',t.goal_id,'sort_order',t.sort_order)
      order by t.id),'[]'::jsonb) from public.tasks t where t.user_id=auth.uid()
      and t.archived_at is null and t.deleted_at is null));
end $$;

create function public.myplan_restructure_timeline(
  task_id uuid,target_kind text,target_id uuid,placement text,expected_version text
) returns void language plpgsql security definer set search_path='' as $$
declare
  source_row public.tasks;
  target_row public.tasks;
  next_parent uuid;
  siblings uuid[];
  old_siblings uuid[];
  insertion integer;
  sibling_id uuid;
  next_order bigint:=0;
  ancestor public.tasks;
  ancestor_id uuid;
  visited uuid[]:='{}';
begin
  if auth.uid() is null or not public.myplan_is_approved() then
    raise exception 'Approved account required.';
  end if;
  if target_kind is null or target_kind not in ('task','goal')
    or placement is null or placement not in ('inside','before','after')
    or (target_kind='goal' and placement<>'inside') then
    raise exception 'Invalid hierarchy drop.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select t.* into source_row from public.tasks t where t.id=task_id
    and t.user_id=auth.uid() and t.archived_at is null and t.deleted_at is null for update;
  if not found then raise exception 'Task not found.';end if;
  if source_row.goal_id is not null and not exists(select 1 from public.goals g
    where g.id=source_row.goal_id and g.user_id=auth.uid()
      and g.status<>'archived' and g.deleted_at is null) then
    raise exception 'Task Goal is not active.';
  end if;
  if expected_version is null or expected_version is distinct from myplan_private.timeline_hierarchy_version() then
    raise exception 'This outline changed. Reload it before moving this Task.';
  end if;
  if target_kind='task' then
    select t.* into target_row from public.tasks t where t.id=target_id
      and t.user_id=auth.uid() and t.archived_at is null and t.deleted_at is null for update;
    if not found then raise exception 'Target Task not found.';end if;
    if target_id=task_id then raise exception 'A Task cannot be dropped on itself.';end if;
    if target_row.goal_id is distinct from source_row.goal_id then
      raise exception 'Hierarchy moves must stay within the same Goal.';
    end if;
    next_parent:=case when placement='inside' then target_id else target_row.parent_task_id end;
  else
    if target_id is not null and not exists(select 1 from public.goals g
      where g.id=target_id and g.user_id=auth.uid() and g.status<>'archived'
        and g.deleted_at is null) then raise exception 'Target Goal is not active.';end if;
    if target_id is distinct from source_row.goal_id then
      raise exception 'Hierarchy moves must stay within the same Goal.';
    end if;
    next_parent:=null;
  end if;
  -- Validate the entire destination path, including rows outside the rendered
  -- viewport. Legacy cycles/orphans must never absorb a healthy branch.
  ancestor_id:=next_parent;
  while ancestor_id is not null loop
    if ancestor_id=task_id then raise exception 'A Task cannot be moved into its own subtree.';end if;
    if ancestor_id=any(visited) then raise exception 'This Task hierarchy needs repair before moving it.';end if;
    visited:=array_append(visited,ancestor_id);
    select t.* into ancestor from public.tasks t where t.id=ancestor_id
      and t.user_id=auth.uid() and t.archived_at is null and t.deleted_at is null;
    if not found or ancestor.goal_id is distinct from source_row.goal_id then
      raise exception 'This Task hierarchy needs repair before moving it.';
    end if;
    ancestor_id:=ancestor.parent_task_id;
  end loop;
  select coalesce(array_agg(t.id order by t.sort_order nulls last,t.created_at,t.id),'{}'::uuid[])
    into old_siblings from public.tasks t where t.user_id=auth.uid()
      and t.archived_at is null and t.deleted_at is null
      and t.goal_id is not distinct from source_row.goal_id
      and t.parent_task_id is not distinct from next_parent;
  siblings:=array_remove(old_siblings,task_id);
  if target_kind='task' and placement in ('before','after') then
    insertion:=array_position(siblings,target_id);
    if insertion is null then raise exception 'Target Task is not in this sibling group.';end if;
    if placement='after' then insertion:=insertion+1;end if;
    siblings:=coalesce(siblings[1:insertion-1],'{}'::uuid[])||array[task_id]||coalesce(siblings[insertion:],'{}'::uuid[]);
  else
    siblings:=array_append(siblings,task_id);
  end if;
  if source_row.parent_task_id is not distinct from next_parent and siblings=old_siblings then
    raise exception 'Task is already in this position.';
  end if;
  if source_row.parent_task_id is distinct from next_parent then
    update public.tasks t set parent_task_id=next_parent where t.id=task_id and t.user_id=auth.uid();
  end if;
  foreach sibling_id in array siblings loop
    next_order:=next_order+1024;
    update public.tasks t set sort_order=next_order where t.id=sibling_id
      and t.user_id=auth.uid() and t.sort_order is distinct from next_order;
  end loop;
end $$;

revoke all on function public.myplan_preview_timeline_hierarchy(uuid),
  public.myplan_restructure_timeline(uuid,text,uuid,text,text) from public,anon;
grant execute on function public.myplan_preview_timeline_hierarchy(uuid),
  public.myplan_restructure_timeline(uuid,text,uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
