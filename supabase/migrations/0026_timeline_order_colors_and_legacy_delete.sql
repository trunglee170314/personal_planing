-- Persist Timeline ordering, milestone color overrides and detach legacy
-- activity history before permanent removal.
begin;

alter table public.goals add column if not exists sort_order bigint;
alter table public.tasks add column if not exists sort_order bigint;
alter table public.timeline_milestones add column if not exists color_key text;
alter table public.timeline_milestones drop constraint if exists timeline_milestones_color_key_check;
alter table public.timeline_milestones add constraint timeline_milestones_color_key_check
  check (color_key is null or color_key in ('jade','teal','sky','sapphire','indigo','plum','amber','terracotta'));

with ranked as (
  select id,row_number() over(partition by user_id order by created_at,id)*1024 as position
  from public.goals where sort_order is null
) update public.goals g set sort_order=ranked.position from ranked where g.id=ranked.id;
with ranked as (
  select id,row_number() over(partition by user_id,goal_id order by created_at,id)*1024 as position
  from public.tasks where sort_order is null
) update public.tasks t set sort_order=ranked.position from ranked where t.id=ranked.id;
create index if not exists goals_user_sort_idx on public.goals(user_id,sort_order,id);
create index if not exists tasks_user_goal_sort_idx on public.tasks(user_id,goal_id,sort_order,id);

create or replace function myplan_private.assign_goal_sort_order() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.sort_order is null then select coalesce(max(sort_order),0)+1024 into new.sort_order from public.goals where user_id=new.user_id;end if;
  return new;
end $$;
create or replace function myplan_private.assign_task_sort_order() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.sort_order is null then select coalesce(max(sort_order),0)+1024 into new.sort_order from public.tasks where user_id=new.user_id and goal_id is not distinct from new.goal_id;end if;
  return new;
end $$;
revoke all on function myplan_private.assign_goal_sort_order(),myplan_private.assign_task_sort_order() from public,anon,authenticated;
drop trigger if exists goal_assign_sort_order on public.goals;
create trigger goal_assign_sort_order before insert on public.goals for each row execute function myplan_private.assign_goal_sort_order();
drop trigger if exists task_assign_sort_order on public.tasks;
create trigger task_assign_sort_order before insert on public.tasks for each row execute function myplan_private.assign_task_sort_order();

do $$ declare legacy record;begin
  for legacy in select * from (values
    ('focus_sessions','task_id'),('focus_sessions','goal_id'),
    ('time_blocks','task_id'),('time_blocks','goal_id')
  ) as links(table_name,column_name) loop
    if pg_catalog.to_regclass('public.'||legacy.table_name) is not null and exists(
      select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=legacy.table_name and c.column_name=legacy.column_name
    ) then execute pg_catalog.format('alter table public.%I alter column %I drop not null',legacy.table_name,legacy.column_name);end if;
  end loop;
end $$;

create or replace function public.myplan_reorder_timeline(
  target_kind text,
  target_id uuid,
  target_goal uuid default null,
  before_id uuid default null
) returns void language plpgsql security definer set search_path='' as $$
declare task_row public.tasks; item record; position bigint:=0; target_parent uuid; effective_before uuid;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  if target_kind not in ('goal','task') then raise exception 'Invalid timeline reorder.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  if target_kind='goal' then
    if not exists(select 1 from public.goals where id=target_id and user_id=auth.uid() and status<>'archived' and deleted_at is null for update) then raise exception 'Goal not found.';end if;
    for item in
      select id from (
        select id,sort_order,created_at from public.goals where user_id=auth.uid() and status<>'archived' and deleted_at is null and id<>target_id
        union all
        select target_id,coalesce((select sort_order-1 from public.goals where id=before_id and user_id=auth.uid()),9223372036854775806),now()
      ) ordered order by sort_order nulls last,created_at,id
    loop position:=position+1024;update public.goals set sort_order=position where id=item.id and user_id=auth.uid();end loop;
  else
    select * into task_row from public.tasks where id=target_id and user_id=auth.uid() and archived_at is null and deleted_at is null for update;
    if not found then raise exception 'Task not found.';end if;
    if target_goal is not null and not exists(select 1 from public.goals where id=target_goal and user_id=auth.uid() and status<>'archived' and deleted_at is null) then raise exception 'Target Goal is not active.';end if;
    if target_goal is distinct from task_row.goal_id then
      -- Only the dragged Task changes group; descendants remain in the old Goal.
      update public.tasks set parent_task_id=null where parent_task_id=target_id and user_id=auth.uid();
      update public.tasks set goal_id=target_goal,parent_task_id=null where id=target_id and user_id=auth.uid();
    end if;
    target_parent:=case when target_goal is distinct from task_row.goal_id then null else task_row.parent_task_id end;
    select id into effective_before from public.tasks where id=before_id and user_id=auth.uid() and goal_id is not distinct from target_goal and parent_task_id is not distinct from target_parent;
    position:=0;
    for item in
      select id from (
        select id,sort_order,created_at from public.tasks where user_id=auth.uid() and archived_at is null and deleted_at is null and goal_id is not distinct from target_goal and parent_task_id is not distinct from target_parent and id<>target_id
        union all
        select target_id,coalesce((select sort_order-1 from public.tasks where id=effective_before and user_id=auth.uid()),9223372036854775806),now()
      ) ordered order by sort_order nulls last,created_at,id
    loop position:=position+1024;update public.tasks set sort_order=position where id=item.id and user_id=auth.uid();end loop;
  end if;
end $$;
revoke all on function public.myplan_reorder_timeline(text,uuid,uuid,uuid) from public,anon;
grant execute on function public.myplan_reorder_timeline(text,uuid,uuid,uuid) to authenticated;

-- focus_sessions/time_blocks are legacy, optional tables. They are history:
-- remove their Task/Goal link but never erase the session itself.
create or replace function myplan_private.detach_optional_reference(target_table text,target_column text,target uuid)
returns void language plpgsql security definer set search_path='' as $$
declare owner_column text;
begin
  if target_table not in ('focus_sessions','time_blocks') or target_column not in ('task_id','goal_id') then raise exception 'Unsupported legacy reference.';end if;
  if pg_catalog.to_regclass('public.'||target_table) is null then return;end if;
  if not exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=target_table and c.column_name=target_column) then return;end if;
  select case when exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=target_table and c.column_name='user_id') then 'user_id'
              when exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=target_table and c.column_name='owner_user_id') then 'owner_user_id' end into owner_column;
  if owner_column is null then raise exception 'Legacy owner column was not found.';end if;
  execute pg_catalog.format('update public.%I set %I=null where %I=$1 and %I=$2',target_table,target_column,target_column,owner_column) using target,auth.uid();
end $$;
revoke all on function myplan_private.detach_optional_reference(text,text,uuid) from public,anon,authenticated;

create or replace function myplan_private.delete_myplan_task(target_task_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.tasks where id=target_task_id and user_id=auth.uid() for update) then raise exception 'Task not found.';end if;
  update public.tasks set parent_task_id=null where parent_task_id=target_task_id and user_id=auth.uid();
  update public.tasks set dependency_task_id=null where dependency_task_id=target_task_id and user_id=auth.uid();
  update public.calendar_entries set task_id=null,item_type='reminder',ends_at=starts_at+interval '15 minutes' where task_id=target_task_id and owner_user_id=auth.uid();
  perform myplan_private.detach_optional_reference('time_blocks','task_id',target_task_id);
  perform myplan_private.detach_optional_reference('focus_sessions','task_id',target_task_id);
  delete from public.tasks where id=target_task_id and user_id=auth.uid();
end $$;

create or replace function myplan_private.delete_myplan_goal(target_goal_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare parent_column text; hierarchy jsonb; relation jsonb;
begin
  if not exists(select 1 from public.goals where id=target_goal_id and user_id=auth.uid() for update) then raise exception 'Goal not found.';end if;
  select case when exists(select 1 from information_schema.columns where table_schema='public' and table_name='goals' and column_name='parent_goal_id') then 'parent_goal_id' when exists(select 1 from information_schema.columns where table_schema='public' and table_name='goals' and column_name='parent_id') then 'parent_id' end into parent_column;
  if parent_column is not null then execute format('update public.goals set %I=null where %I=$1 and user_id=$2',parent_column,parent_column) using target_goal_id,auth.uid();end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'parent',parent_task_id)) filter(where parent_task_id is not null),'[]') into hierarchy from public.tasks where goal_id=target_goal_id and user_id=auth.uid();
  -- The hierarchy trigger intentionally rejects half-moved trees. Detach the
  -- links, move the complete group to Inbox, then restore the same tree.
  update public.tasks set parent_task_id=null where goal_id=target_goal_id and user_id=auth.uid() and parent_task_id is not null;
  update public.tasks set goal_id=null where goal_id=target_goal_id and user_id=auth.uid();
  for relation in select value from jsonb_array_elements(hierarchy) loop
    update public.tasks set parent_task_id=(relation->>'parent')::uuid where id=(relation->>'id')::uuid and user_id=auth.uid();
  end loop;
  perform myplan_private.detach_optional_reference('time_blocks','goal_id',target_goal_id);
  perform myplan_private.detach_optional_reference('focus_sessions','goal_id',target_goal_id);
  delete from public.goals where id=target_goal_id and user_id=auth.uid();
end $$;

notify pgrst,'reload schema';
commit;
