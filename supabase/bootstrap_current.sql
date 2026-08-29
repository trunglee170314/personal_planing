-- Fresh-install schema for the current myplan application.
-- Run this file once in an empty Supabase project. Existing projects should
-- use only the numbered migrations that have not yet been applied.

create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  timezone text not null default 'Asia/Ho_Chi_Minh',
  theme text not null default 'jade'
    check (theme in ('jade','sapphire','ink','paper')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  description text,
  starts_at date,
  ends_at date,
  progress smallint not null default 0 check (progress between 0 and 100),
  status text not null default 'active'
    check (status in ('active','completed','archived')),
  color_key text not null default 'jade'
    check (color_key in ('jade','teal','sky','sapphire','indigo','plum','amber','terracotta')),
  completed_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 240),
  description text,
  priority text not null default 'medium'
    check (priority in ('low','medium','high','urgent')),
  status text not null default 'backlog'
    check (status in ('backlog','planned','in_progress','blocked','completed','cancelled')),
  previous_status text,
  planned_start date,
  planned_end date,
  due_at timestamptz,
  progress smallint not null default 0 check (progress between 0 and 100),
  parent_task_id uuid,
  dependency_task_id uuid,
  goal_id uuid,
  is_milestone boolean not null default false,
  link_url text check (link_url is null or link_url ~ '^https?://'),
  link_label text,
  completed_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (parent_task_id, user_id)
    references public.tasks(id, user_id),
  foreign key (dependency_task_id, user_id)
    references public.tasks(id, user_id),
  foreign key (goal_id, user_id)
    references public.goals(id, user_id),
  check (parent_task_id is null or parent_task_id <> id),
  check (planned_end is null or planned_start is null or planned_end >= planned_start),
  check (due_at is null or planned_start is null or due_at::date >= planned_start)
);

create table public.calendar_entries (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  task_id uuid,
  title text not null check (length(trim(title)) between 1 and 240),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  timezone text not null default 'Asia/Ho_Chi_Minh'
    check (timezone = 'Asia/Ho_Chi_Minh'),
  entry_type text not null default 'time_block',
  flexibility text not null default 'fixed',
  status text not null default 'planned',
  item_type text not null default 'checklist'
    check (item_type in ('checklist','reminder')),
  completed_at timestamptz,
  not_needed_at timestamptz,
  notification_offsets integer[] not null default array[15]
    check (notification_offsets <@ array[0,5,15,60,1440]),
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (task_id, owner_user_id)
    references public.tasks(id, user_id) on delete cascade,
  check (ends_at > starts_at),
  check (completed_at is null or not_needed_at is null),
  check (item_type <> 'checklist' or task_id is not null),
  check (item_type <> 'reminder' or task_id is null),
  check (item_type <> 'reminder' or ends_at = starts_at + interval '15 minutes')
);

create table public.recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  calendar_entry_id uuid not null,
  rrule text not null,
  timezone text not null default 'Asia/Ho_Chi_Minh',
  created_at timestamptz not null default now(),
  unique (calendar_entry_id),
  foreign key (calendar_entry_id, owner_user_id)
    references public.calendar_entries(id, owner_user_id) on delete cascade
);

create table public.calendar_occurrence_states (
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  calendar_entry_id uuid not null,
  occurrence_start timestamptz not null,
  completed_at timestamptz,
  not_needed_at timestamptz,
  override_starts_at timestamptz,
  override_ends_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, calendar_entry_id, occurrence_start),
  foreign key (calendar_entry_id, owner_user_id)
    references public.calendar_entries(id, owner_user_id) on delete cascade,
  check (completed_at is null or not_needed_at is null),
  check (
    (override_starts_at is null and override_ends_at is null) or
    (override_starts_at is not null and override_ends_at > override_starts_at)
  )
);

create table public.timeline_milestones (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  goal_id uuid,
  title text not null check (length(trim(title)) between 1 and 200),
  milestone_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (goal_id, owner_user_id)
    references public.goals(id, user_id) on delete cascade
);

create table public.pomodoro_settings (
  owner_user_id uuid primary key default auth.uid()
    references auth.users(id) on delete cascade,
  focus_minutes smallint not null default 25 check (focus_minutes between 1 and 120),
  short_break_minutes smallint not null default 5 check (short_break_minutes between 1 and 60),
  long_break_minutes smallint not null default 15 check (long_break_minutes between 1 and 120),
  daily_target_type text not null default 'sessions'
    check (daily_target_type in ('sessions','minutes')),
  daily_target_value smallint not null default 4
    check (daily_target_value between 1 and 240),
  updated_at timestamptz not null default now()
);

create table public.pomodoro_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  session_type text not null default 'focus',
  started_at timestamptz not null,
  expected_end_at timestamptz not null,
  completed_at timestamptz,
  duration_seconds integer not null check (duration_seconds > 0),
  status text not null default 'completed',
  actual_focus_seconds integer,
  client_id text not null,
  created_at timestamptz not null default now(),
  unique (owner_user_id, client_id)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  review_type text not null default 'weekly',
  period_start date not null,
  period_end date not null,
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, review_type, period_start)
);

create table public.notification_preferences (
  owner_user_id uuid primary key default auth.uid()
    references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index goals_user_lifecycle_idx
  on public.goals(user_id, deleted_at, status, created_at desc);
create index tasks_user_lifecycle_idx
  on public.tasks(user_id, deleted_at, archived_at, created_at desc);
create index tasks_user_plan_idx
  on public.tasks(user_id, planned_start, due_at);
create index calendar_entries_owner_range_idx
  on public.calendar_entries(owner_user_id, starts_at, ends_at)
  where status <> 'cancelled';
create index calendar_entries_owner_overdue_idx
  on public.calendar_entries(owner_user_id, starts_at)
  where item_type = 'reminder' and completed_at is null and not_needed_at is null;
create index calendar_occurrence_states_owner_recent_idx
  on public.calendar_occurrence_states(owner_user_id, occurrence_start desc);
create index timeline_milestones_owner_date_idx
  on public.timeline_milestones(owner_user_id, milestone_on);
create index pomodoro_sessions_owner_completed_idx
  on public.pomodoro_sessions(owner_user_id, completed_at desc);
create index reviews_owner_period_idx
  on public.reviews(owner_user_id, period_start desc);

alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.tasks enable row level security;
alter table public.calendar_entries enable row level security;
alter table public.recurrence_rules enable row level security;
alter table public.calendar_occurrence_states enable row level security;
alter table public.timeline_milestones enable row level security;
alter table public.pomodoro_settings enable row level security;
alter table public.pomodoro_sessions enable row level security;
alter table public.reviews enable row level security;
alter table public.notification_preferences enable row level security;

create policy profiles_own_rows on public.profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy goals_own_rows on public.goals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tasks_own_rows on public.tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy calendar_entries_own_rows on public.calendar_entries for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy recurrence_rules_own_rows on public.recurrence_rules for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy calendar_occurrence_states_own_rows on public.calendar_occurrence_states for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy timeline_milestones_own_rows on public.timeline_milestones for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy pomodoro_settings_own_rows on public.pomodoro_settings for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy pomodoro_sessions_own_rows on public.pomodoro_sessions for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy reviews_own_rows on public.reviews for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy notification_preferences_own_rows on public.notification_preferences for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create or replace function public.bootstrap_myplan_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id,email,display_name)
  values (
    new.id,
    coalesce(new.email,''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'),''), split_part(coalesce(new.email,'myplan user'),'@',1))
  ) on conflict (id) do update set email=excluded.email, display_name=excluded.display_name;
  insert into public.pomodoro_settings (owner_user_id)
    values (new.id) on conflict (owner_user_id) do nothing;
  insert into public.notification_preferences (owner_user_id)
    values (new.id) on conflict (owner_user_id) do nothing;
  return new;
end;
$$;

create trigger bootstrap_myplan_user_after_signup
after insert on auth.users for each row execute function public.bootstrap_myplan_user();

create or replace function public.apply_myplan_goal_task_progress()
returns trigger language plpgsql security definer set search_path = '' as $$
declare total_tasks integer; completed_tasks integer;
begin
  if new.status = 'archived' or new.deleted_at is not null then return new; end if;
  with eligible as (
    select task.id,task.parent_task_id,task.status from public.tasks task
    where task.goal_id=new.id and task.archived_at is null and task.deleted_at is null
      and task.status <> 'cancelled'
  ), leaves as (
    select task.* from eligible task where not exists (
      select 1 from eligible child where child.parent_task_id=task.id
    )
  )
  select count(*),count(*) filter (where status='completed')
    into total_tasks,completed_tasks from leaves;
  if total_tasks > 0 then
    new.progress := round(completed_tasks * 100.0 / total_tasks)::smallint;
    new.status := case when completed_tasks=total_tasks then 'completed' else 'active' end;
    new.completed_at := case when completed_tasks=total_tasks then coalesce(new.completed_at,now()) else null end;
  end if;
  return new;
end;
$$;

create trigger goals_apply_task_progress
before insert or update of progress,status,deleted_at on public.goals
for each row execute function public.apply_myplan_goal_task_progress();

create or replace function public.sync_myplan_task_goal_progress()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' and old.goal_id is not null then
    update public.goals set progress=progress where id=old.goal_id;
  end if;
  if tg_op <> 'DELETE' and new.goal_id is not null
     and (tg_op='INSERT' or new.goal_id is distinct from old.goal_id) then
    update public.goals set progress=progress where id=new.goal_id;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create trigger tasks_sync_goal_progress
after insert or delete or update of goal_id,status,parent_task_id,archived_at,deleted_at
on public.tasks for each row execute function public.sync_myplan_task_goal_progress();

create or replace function public.validate_checklist_recurrence_horizon()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare target_item_type text;
begin
  select item_type into target_item_type from public.calendar_entries
  where id=new.calendar_entry_id and owner_user_id=new.owner_user_id;
  if target_item_type='checklist' and new.rrule not like '%UNTIL=%' then
    raise exception 'A repeating Checklist requires a repeat-until date.';
  end if;
  return new;
end;
$$;
create trigger recurrence_rules_validate_checklist_horizon
before insert or update of rrule,calendar_entry_id on public.recurrence_rules
for each row execute function public.validate_checklist_recurrence_horizon();

create or replace function public.move_calendar_series(
  target_entry_id uuid,
  original_occurrence_start timestamptz,
  original_occurrence_end timestamptz,
  next_occurrence_start timestamptz,
  next_occurrence_end timestamptz
)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  entry_row public.calendar_entries%rowtype;
  delta_start interval;
  delta_end interval;
  delta_days integer;
begin
  select * into entry_row from public.calendar_entries
  where id=target_entry_id and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.'; end if;
  if next_occurrence_end <= next_occurrence_start then
    raise exception 'Series end must be after its start.';
  end if;
  if entry_row.item_type='reminder' then
    next_occurrence_end := next_occurrence_start + interval '15 minutes';
  end if;
  delta_start := next_occurrence_start - original_occurrence_start;
  delta_end := next_occurrence_end - original_occurrence_end;
  delta_days :=
    (next_occurrence_start at time zone 'Asia/Ho_Chi_Minh')::date -
    (original_occurrence_start at time zone 'Asia/Ho_Chi_Minh')::date;
  update public.calendar_entries
    set starts_at=starts_at+delta_start,ends_at=ends_at+delta_end
    where id=target_entry_id and owner_user_id=auth.uid();
  if delta_days <> 0 then
    update public.recurrence_rules
    set rrule=regexp_replace(
      rrule,'UNTIL=[0-9]{8}T235959Z',
      'UNTIL=' || to_char(
        to_date(substring(rrule from 'UNTIL=([0-9]{8})'),'YYYYMMDD') + delta_days,
        'YYYYMMDD'
      ) || 'T235959Z'
    )
    where calendar_entry_id=target_entry_id and owner_user_id=auth.uid()
      and rrule like '%UNTIL=%';
  end if;
  update public.calendar_occurrence_states
    set occurrence_start=occurrence_start+interval '400 years'
    where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
  update public.calendar_occurrence_states
    set occurrence_start=occurrence_start-interval '400 years'+delta_start,
      override_starts_at=case when override_starts_at is null then null else override_starts_at+delta_start end,
      override_ends_at=case when override_ends_at is null then null else override_ends_at+delta_end end
    where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
end;
$$;
revoke all on function public.move_calendar_series(uuid,timestamptz,timestamptz,timestamptz,timestamptz) from public;
grant execute on function public.move_calendar_series(uuid,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated;

create or replace function public.detach_legacy_time_blocks(
  target_column text,
  target_id uuid
)
returns void language plpgsql security invoker set search_path = '' as $$
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
returns void language plpgsql security invoker set search_path = '' as $$
declare
  parent_column text;
  owner_column text;
begin
  if not exists (
    select 1 from public.goals where id=target_goal_id and user_id=auth.uid()
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
  delete from public.goals where id=target_goal_id and user_id=auth.uid();
end;
$$;
revoke all on function public.delete_myplan_goal(uuid) from public;
grant execute on function public.delete_myplan_goal(uuid) to authenticated;

create or replace function public.delete_myplan_task(target_task_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tasks where id=target_task_id and user_id=auth.uid()
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
  delete from public.tasks where id=target_task_id and user_id=auth.uid();
end;
$$;
revoke all on function public.delete_myplan_task(uuid) from public;
grant execute on function public.delete_myplan_task(uuid) to authenticated;

create or replace function public.set_myplan_task_completion(
  target_task_id uuid,
  should_complete boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  task_row public.tasks%rowtype;
  changed_at timestamptz := now();
  next_status text;
begin
  select * into task_row from public.tasks
  where id=target_task_id and user_id=auth.uid() for update;
  if not found then raise exception 'Task not found.'; end if;
  if should_complete then
    update public.calendar_entries
    set not_needed_at=changed_at,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and completed_at is null
      and not_needed_at is null;
    update public.tasks
    set previous_status=case when status='completed' then previous_status else status end,
        status='completed',completed_at=changed_at,progress=100,updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  else
    update public.calendar_entries
    set not_needed_at=null,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and not_needed_at=task_row.completed_at;
    next_status := coalesce(task_row.previous_status,'planned');
    update public.tasks
    set status=next_status,previous_status=null,completed_at=null,progress=0,updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  end if;
end;
$$;
revoke all on function public.set_myplan_task_completion(uuid,boolean) from public;
grant execute on function public.set_myplan_task_completion(uuid,boolean) to authenticated;
-- Reviewed completion/recurrence implementation. This intentionally replaces
-- the compact definition above while keeping this bootstrap readable by section.
-- Allow an explicit Task completion while keeping checklist history honest.
-- Every unresolved occurrence in a finite repeating checklist is marked with
-- the Task completion timestamp. Reopening restores only those exact skips.

create or replace function public.myplan_month_occurrence(
  base_start timestamptz,
  months_to_add integer
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  with local_value as (
    select base_start at time zone 'Asia/Ho_Chi_Minh' as value
  ), target_month as (
    select value,
      date_trunc('month',value) + make_interval(months => months_to_add) as first_day
    from local_value
  )
  select (
    make_date(
      extract(year from first_day)::integer,
      extract(month from first_day)::integer,
      least(
        extract(day from value)::integer,
        extract(day from (first_day + interval '1 month' - interval '1 day'))::integer
      )
    )::timestamp + value::time
  ) at time zone 'Asia/Ho_Chi_Minh'
  from target_month;
$$;

revoke all on function public.myplan_month_occurrence(timestamptz,integer) from public;
grant execute on function public.myplan_month_occurrence(timestamptz,integer)
  to authenticated,service_role;

create or replace function public.set_myplan_task_completion(
  target_task_id uuid,
  should_complete boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  task_row public.tasks%rowtype;
  changed_at timestamptz := now();
  next_status text;
  checklist_total integer := 0;
  checklist_resolved integer := 0;
begin
  select * into task_row from public.tasks
  where id=target_task_id and user_id=auth.uid() for update;
  if not found then raise exception 'Task not found.'; end if;
  if (task_row.completed_at is not null)=should_complete then return; end if;

  if should_complete then
    update public.calendar_entries
    set not_needed_at=changed_at,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and completed_at is null
      and not_needed_at is null;

    with specs as (
      select e.id,e.owner_user_id,e.starts_at,r.rrule,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly' else 'daily' end as frequency,
        to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
          'YYYYMMDD"T"HH24MISS"Z"') as until_at
      from public.calendar_entries e join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
      select s.*,
        case s.frequency
          when 'daily' then s.starts_at + make_interval(days => n*s.step)
          when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
          else public.myplan_month_occurrence(s.starts_at,n*s.step)
        end as occurrence_start
      from specs s cross join lateral generate_series(0,999) n
    )
    insert into public.calendar_occurrence_states
      (owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,updated_at)
    select owner_user_id,id,occurrence_start,null,changed_at,changed_at
    from occurrences where occurrence_start<=until_at
    on conflict (owner_user_id,calendar_entry_id,occurrence_start) do update
      set not_needed_at=excluded.not_needed_at,updated_at=excluded.updated_at
      where public.calendar_occurrence_states.completed_at is null
        and public.calendar_occurrence_states.not_needed_at is null;

    update public.tasks set
      previous_status=case when status='completed' then previous_status else status end,
      status='completed',completed_at=changed_at,progress=100,updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  else
    update public.calendar_entries set not_needed_at=null,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and not_needed_at=task_row.completed_at;

    update public.calendar_occurrence_states state
    set not_needed_at=null,updated_at=changed_at
    where state.owner_user_id=auth.uid() and state.not_needed_at=task_row.completed_at
      and exists (select 1 from public.calendar_entries entry
        where entry.id=state.calendar_entry_id and entry.task_id=target_task_id
          and entry.item_type='checklist');

    with specs as (
      select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly'
          when r.rrule is not null then 'daily' else 'none' end as frequency,
        case when r.rrule is not null then
          to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
            'YYYYMMDD"T"HH24MISS"Z"') end as until_at
      from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
      select s.*,
        case s.frequency
          when 'daily' then s.starts_at + make_interval(days => n*s.step)
          when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
          when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step)
          else s.starts_at
        end as occurrence_start
      from specs s cross join lateral
        generate_series(0,case when s.frequency='none' then 0 else 999 end) n
    ), outcomes as (
      select coalesce(state.completed_at,o.completed_at) as completed_at,
        coalesce(state.not_needed_at,o.not_needed_at) as not_needed_at
      from occurrences o left join public.calendar_occurrence_states state
        on state.calendar_entry_id=o.id and state.occurrence_start=o.occurrence_start
      where o.frequency='none' or o.occurrence_start<=o.until_at
    )
    select count(*),count(*) filter (
      where completed_at is not null or not_needed_at is not null
    ) into checklist_total,checklist_resolved from outcomes;

    next_status := coalesce(task_row.previous_status,'planned');
    update public.tasks set
      status=case when checklist_total>0 and checklist_resolved=checklist_total
        then 'completed' else next_status end,
      previous_status=case when checklist_total>0 and checklist_resolved=checklist_total
        then next_status else null end,
      completed_at=case when checklist_total>0 and checklist_resolved=checklist_total
        then changed_at else null end,
      progress=case when checklist_total=0 then 0
        else round(checklist_resolved*100.0/checklist_total)::integer end,
      updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  end if;
end;
$$;

revoke all on function public.set_myplan_task_completion(uuid,boolean) from public;
grant execute on function public.set_myplan_task_completion(uuid,boolean) to authenticated;



-- Each browser/PWA installation keeps its own Web Push subscription. Delivery
-- rows are written only by the server-side scheduler and deduplicate retries.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null, p256dh text not null, auth text not null, user_agent text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(), disabled_at timestamptz,
  unique(owner_user_id,endpoint),
  check(length(endpoint)<=2048),check(length(p256dh)<=512),check(length(auth)<=256),
  check(endpoint ~ '^https://([A-Za-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)(/|$)')
);
create table if not exists public.push_delivery_log (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  calendar_entry_id uuid not null references public.calendar_entries(id) on delete cascade,
  occurrence_start timestamptz not null, offset_minutes integer not null,
  delivered_at timestamptz not null default now(),
  unique(subscription_id,calendar_entry_id,occurrence_start,offset_minutes)
);
alter table public.push_subscriptions enable row level security;
alter table public.push_delivery_log enable row level security;
create policy push_subscriptions_own_rows on public.push_subscriptions for all to authenticated
using(owner_user_id=auth.uid()) with check(owner_user_id=auth.uid());
create policy push_delivery_log_own_rows on public.push_delivery_log for select to authenticated
using(owner_user_id=auth.uid());
create index if not exists push_subscriptions_active_owner_idx on public.push_subscriptions(owner_user_id) where disabled_at is null;
create or replace function public.limit_myplan_push_subscriptions()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.push_subscriptions where owner_user_id=new.owner_user_id and endpoint=new.endpoint) then return new; end if;
  if(select count(*) from public.push_subscriptions where owner_user_id=new.owner_user_id and disabled_at is null)>=8 then
    raise exception 'This account already has 8 active notification devices.';
  end if;
  return new;
end;
$$;
create trigger push_subscriptions_limit_active before insert on public.push_subscriptions
for each row execute function public.limit_myplan_push_subscriptions();
create or replace function public.get_due_push_jobs(check_at timestamptz)
returns table(subscription_id uuid,owner_user_id uuid,endpoint text,p256dh text,auth text,calendar_entry_id uuid,occurrence_start timestamptz,offset_minutes integer,item_type text,item_title text)
language sql security definer set search_path='' as $$
with entry_rules as (
select e.*,r.rrule,coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) step,
case when r.rrule like '%FREQ=MONTHLY%' then 'monthly' when r.rrule like '%FREQ=WEEKLY%' then 'weekly' when r.rrule is not null then 'daily' else 'none' end frequency,
case when r.rrule like '%UNTIL=%' then to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],'YYYYMMDD"T"HH24MISS"Z"') end until_at
from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
where e.status<>'cancelled' and e.completed_at is null and e.not_needed_at is null), starts as (
select er.*,greatest(0,case er.frequency
when 'daily' then floor(extract(epoch from ((check_at-interval '3 minutes')-er.starts_at))/(86400*er.step))::integer-1
when 'weekly' then floor(extract(epoch from ((check_at-interval '3 minutes')-er.starts_at))/(604800*er.step))::integer-1
when 'monthly' then floor(((extract(year from age(check_at,er.starts_at))*12)+extract(month from age(check_at,er.starts_at)))/er.step)::integer-1 else 0 end) first_n from entry_rules er), occurrences as (
select s.*,case s.frequency when 'daily' then s.starts_at+make_interval(days=>n*s.step) when 'weekly' then s.starts_at+make_interval(days=>n*s.step*7) when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step) else s.starts_at end original_start
from starts s cross join lateral generate_series(s.first_n,case when s.frequency='none' then s.first_n else s.first_n+4 end)n), effective as (
select o.*,coalesce(st.override_starts_at,o.original_start) shown_start,st.completed_at occurrence_completed_at,st.not_needed_at occurrence_not_needed_at
from occurrences o left join public.calendar_occurrence_states st on st.calendar_entry_id=o.id and st.occurrence_start=o.original_start
where(o.until_at is null or o.original_start<=o.until_at))
select ps.id,ps.owner_user_id,ps.endpoint,ps.p256dh,ps.auth,e.id,e.original_start,offset_value,e.item_type,e.title
from effective e join public.push_subscriptions ps on ps.owner_user_id=e.owner_user_id and ps.disabled_at is null
cross join lateral unnest(e.notification_offsets)offset_value
where e.occurrence_completed_at is null and e.occurrence_not_needed_at is null
and e.shown_start-offset_value*interval '1 minute'<=check_at and e.shown_start-offset_value*interval '1 minute'>check_at-interval '3 minutes'
and not exists(select 1 from public.push_delivery_log d where d.subscription_id=ps.id and d.calendar_entry_id=e.id and d.occurrence_start=e.original_start and d.offset_minutes=offset_value)
limit 500;
$$;
revoke all on function public.get_due_push_jobs(timestamptz) from public;
grant execute on function public.get_due_push_jobs(timestamptz) to service_role;

create table if not exists public.push_test_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  error_code text,
  check (error_code is null or length(error_code) <= 80)
);

alter table public.push_test_requests enable row level security;
create policy push_test_requests_own_rows on public.push_test_requests
for select to authenticated using (owner_user_id = auth.uid());
create index if not exists push_test_requests_pending_idx
on public.push_test_requests(requested_at) where delivered_at is null;

create or replace function public.request_myplan_push_test(target_endpoint text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  target_subscription_id uuid;
  request_id uuid;
begin
  if current_user_id is null then
    raise exception 'Sign in before requesting a push test.';
  end if;
  select id into target_subscription_id from public.push_subscriptions
  where owner_user_id = current_user_id and endpoint = target_endpoint
    and disabled_at is null limit 1;
  if target_subscription_id is null then
    raise exception 'Enable notifications on this device first.';
  end if;
  if exists(select 1 from public.push_test_requests
    where owner_user_id = current_user_id
      and requested_at > now() - interval '15 seconds') then
    raise exception 'Wait 15 seconds before sending another push test.';
  end if;
  insert into public.push_test_requests(owner_user_id, subscription_id)
  values(current_user_id, target_subscription_id) returning id into request_id;
  return request_id;
end;
$$;
revoke all on function public.request_myplan_push_test(text) from public;
grant execute on function public.request_myplan_push_test(text) to authenticated;

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();
create trigger goals_touch_updated_at before update on public.goals
for each row execute function public.touch_updated_at();
create trigger tasks_touch_updated_at before update on public.tasks
for each row execute function public.touch_updated_at();
create trigger calendar_entries_touch_updated_at before update on public.calendar_entries
for each row execute function public.touch_updated_at();
create trigger calendar_occurrence_states_touch_updated_at before update on public.calendar_occurrence_states
for each row execute function public.touch_updated_at();
create trigger timeline_milestones_touch_updated_at before update on public.timeline_milestones
for each row execute function public.touch_updated_at();
create trigger pomodoro_settings_touch_updated_at before update on public.pomodoro_settings
for each row execute function public.touch_updated_at();
create trigger reviews_touch_updated_at before update on public.reviews
for each row execute function public.touch_updated_at();
create trigger notification_preferences_touch_updated_at before update on public.notification_preferences
for each row execute function public.touch_updated_at();
