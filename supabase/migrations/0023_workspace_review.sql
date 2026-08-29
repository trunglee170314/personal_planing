-- Additive migration. Requires 0021/0022; no planner records are deleted.
begin;
alter table public.goals drop constraint if exists goals_color_key_check;
alter table public.goals add constraint goals_color_key_check check(color_key in ('jade','teal','sky','sapphire','indigo','plum','amber','terracotta','rose','coral','lime','slate'));
alter table public.timeline_milestones add column task_id uuid;
alter table public.timeline_milestones add constraint milestone_task_owner_fk
  foreign key(task_id,owner_user_id) references public.tasks(id,user_id) on delete set null (task_id);
alter table public.timeline_milestones add constraint milestone_one_parent check (task_id is null or goal_id is null);
-- The enclosing transaction replaces all legacy Goal FKs with the
-- same owner-bound integrity constraint below, changing only delete behavior.
-- No milestone or annotation row is deleted by this migration.
do $$ declare item record; begin
  for item in select conname from pg_constraint where conrelid='public.timeline_milestones'::regclass and confrelid='public.goals'::regclass and contype='f' loop
    execute format('alter table public.timeline_milestones drop constraint %I',item.conname);
  end loop;
end $$;
alter table public.timeline_milestones add constraint timeline_milestones_goal_owner_fk foreign key(goal_id,owner_user_id) references public.goals(id,user_id) on delete set null (goal_id);

create table public.planner_annotations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid, calendar_entry_id uuid, milestone_id uuid,
  kind text not null check(kind in ('comment','link')),
  body text not null check(length(btrim(body)) between 1 and 10000),
  url text check(url is null or (length(url)<=2048 and url ~* '^https?://[^[:space:]]+$')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(num_nonnulls(task_id,calendar_entry_id,milestone_id)=1),
  check((kind='comment' and url is null) or (kind='link' and url is not null)),
  foreign key(task_id,owner_user_id) references public.tasks(id,user_id) on delete cascade,
  foreign key(calendar_entry_id,owner_user_id) references public.calendar_entries(id,owner_user_id) on delete cascade,
  foreign key(milestone_id,owner_user_id) references public.timeline_milestones(id,owner_user_id) on delete cascade
);
create index annotations_task on public.planner_annotations(owner_user_id,task_id,created_at) where task_id is not null;
create index annotations_calendar on public.planner_annotations(owner_user_id,calendar_entry_id,created_at) where calendar_entry_id is not null;
create index annotations_milestone on public.planner_annotations(owner_user_id,milestone_id,created_at) where milestone_id is not null;
create function myplan_private.touch_annotation() returns trigger language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end $$;
revoke all on function myplan_private.touch_annotation() from public,anon,authenticated;
create trigger annotation_updated_at before update on public.planner_annotations for each row execute function myplan_private.touch_annotation();
create table public.planner_holidays (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check(length(btrim(title)) between 1 and 200),
  starts_on date not null, ends_on date not null,
  created_at timestamptz not null default now(),
  check(ends_on>=starts_on and starts_on>='2000-01-01' and ends_on<='2200-12-31')
);
create index holidays_owner_dates on public.planner_holidays(owner_user_id,starts_on,ends_on);
do $$ declare tab text; begin
  foreach tab in array array['planner_annotations','planner_holidays'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('create policy own_rows on public.%I for all to authenticated using(owner_user_id=(select auth.uid())) with check(owner_user_id=(select auth.uid()))',tab);
    execute format('create policy myplan_approved_access on public.%I as restrictive for all to authenticated using((select public.myplan_is_approved())) with check((select public.myplan_is_approved()))',tab);
    execute format('create trigger myplan_guard_write before insert or update or delete on public.%I for each row execute function myplan_private.guard_write()',tab);
    execute format('create trigger myplan_record_quota after insert on public.%I for each row execute function myplan_private.enforce_record_quota(''owner_user_id'')',tab);
    execute format('grant select,insert,update,delete on public.%I to authenticated',tab);
    execute format('revoke all on public.%I from anon',tab);
  end loop;
end $$;
create or replace function myplan_private.record_count(target uuid)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare tab text; owner_col text; total bigint:=0; n bigint;
begin
  foreach tab in array array['goals','tasks','calendar_entries','recurrence_rules','calendar_occurrence_states','timeline_milestones','pomodoro_sessions','reviews','push_subscriptions','planner_annotations','planner_holidays'] loop
    if to_regclass('public.'||tab) is null then continue; end if;
    owner_col:=case when tab in ('goals','tasks') then 'user_id' else 'owner_user_id' end;
    execute format('select count(*) from public.%I where %I=$1',tab,owner_col) into n using target;
    total:=total+n;
  end loop;
  return total;
end $$;
revoke all on function myplan_private.record_count(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
create function myplan_private.guard_task_hierarchy() returns trigger
language plpgsql security definer set search_path='' as $$
declare parent_goal uuid;
begin
  if new.parent_task_id is not null then
    select goal_id into parent_goal from public.tasks where id=new.parent_task_id and user_id=new.user_id;
    if not found or parent_goal is distinct from new.goal_id then raise exception 'Parent task must belong to the same Goal.'; end if;
    if exists(with recursive ancestors as (
      select id,parent_task_id from public.tasks where id=new.parent_task_id and user_id=new.user_id
      union
      select t.id,t.parent_task_id from public.tasks t join ancestors a on t.id=a.parent_task_id where t.user_id=new.user_id
    ) select 1 from ancestors where id=new.id) then raise exception 'A task cannot be its own ancestor.'; end if;
  end if;
  if exists(select 1 from public.tasks where parent_task_id=new.id and user_id=new.user_id and goal_id is distinct from new.goal_id) then
    raise exception 'Move or detach child tasks before changing this task’s Goal.';
  end if;
  return new;
end $$;
revoke all on function myplan_private.guard_task_hierarchy() from public,anon,authenticated;
create trigger task_hierarchy before insert or update of parent_task_id,goal_id on public.tasks for each row execute function myplan_private.guard_task_hierarchy();
commit;
