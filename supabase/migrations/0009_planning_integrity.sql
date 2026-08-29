-- Per-occurrence completion for repeating calendar items plus account-bound
-- foreign keys and server-side validation for current planning data.

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_entries_id_owner_unique'
  ) then
    alter table public.calendar_entries
      add constraint calendar_entries_id_owner_unique unique (id, owner_user_id);
  end if;
end $$;

create table if not exists public.calendar_occurrence_states (
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  calendar_entry_id uuid not null,
  occurrence_start timestamptz not null,
  completed_at timestamptz,
  not_needed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, calendar_entry_id, occurrence_start),
  constraint calendar_occurrence_states_entry_owner_fk
    foreign key (calendar_entry_id, owner_user_id)
    references public.calendar_entries(id, owner_user_id) on delete cascade,
  constraint calendar_occurrence_states_single_outcome_check
    check (completed_at is null or not_needed_at is null)
);

create index if not exists calendar_occurrence_states_owner_recent_idx
  on public.calendar_occurrence_states(owner_user_id, occurrence_start desc);

alter table public.calendar_occurrence_states enable row level security;
drop policy if exists calendar_occurrence_states_own_rows
  on public.calendar_occurrence_states;
create policy calendar_occurrence_states_own_rows
  on public.calendar_occurrence_states for all to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop trigger if exists calendar_occurrence_states_touch_updated_at
  on public.calendar_occurrence_states;
create trigger calendar_occurrence_states_touch_updated_at
before update on public.calendar_occurrence_states
for each row execute function public.touch_updated_at();

-- 0008 classified legacy calendar rows as Checklists by default. Rows that
-- never belonged to a Task are preserved as point-in-time Reminders before the
-- new hierarchy constraint starts enforcing future writes.
update public.calendar_entries
set item_type = 'reminder',
    ends_at = starts_at + interval '15 minutes',
    updated_at = now()
where item_type = 'checklist' and task_id is null;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_start_deadline_check'
  ) then
    alter table public.tasks add constraint tasks_start_deadline_check
      check (
        due_at is null or planned_start is null or due_at::date >= planned_start
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_entries_checklist_task_check'
  ) then
    alter table public.calendar_entries
      add constraint calendar_entries_checklist_task_check
      check (item_type <> 'checklist' or task_id is not null) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_entries_vietnam_timezone_check'
  ) then
    alter table public.calendar_entries
      add constraint calendar_entries_vietnam_timezone_check
      check (timezone = 'Asia/Ho_Chi_Minh') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_entries_reminder_shape_check'
  ) then
    alter table public.calendar_entries
      add constraint calendar_entries_reminder_shape_check
      check (
        item_type <> 'reminder' or
        (task_id is null and ends_at = starts_at + interval '15 minutes')
      ) not valid;
  end if;
end $$;

-- The production schema stores goal ownership in goals.user_id. Bind a
-- milestone's Goal to the same account instead of trusting RLS alone.
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'goals'
      and column_name = 'user_id'
  ) then
    if not exists (
      select 1 from pg_constraint where conname = 'goals_id_user_id_unique'
    ) then
      alter table public.goals
        add constraint goals_id_user_id_unique unique (id, user_id);
    end if;
    alter table public.timeline_milestones
      drop constraint if exists timeline_milestones_goal_id_fkey;
    if not exists (
      select 1 from pg_constraint
      where conname = 'timeline_milestones_goal_owner_fk'
    ) then
      alter table public.timeline_milestones
        add constraint timeline_milestones_goal_owner_fk
        foreign key (goal_id, owner_user_id)
        references public.goals(id, user_id) on delete cascade;
    end if;
  end if;
end $$;
