-- Extend the production myplan schema. Existing goals/tasks/calendar/Pomodoro data is preserved.
alter table public.tasks add column if not exists planned_start date;
alter table public.tasks add column if not exists planned_end date;
alter table public.tasks add column if not exists progress smallint not null default 0 check (progress between 0 and 100);
alter table public.tasks add column if not exists dependency_task_id uuid;
alter table public.tasks add column if not exists is_milestone boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_planned_range_check') then
    alter table public.tasks add constraint tasks_planned_range_check check (planned_end is null or planned_start is null or planned_end >= planned_start);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_dependency_task_fk') then
    alter table public.tasks add constraint tasks_dependency_task_fk foreign key (dependency_task_id) references public.tasks(id) on delete set null;
  end if;
end $$;

alter table public.pomodoro_settings add column if not exists daily_target_type text not null default 'sessions' check (daily_target_type in ('sessions','minutes'));
alter table public.pomodoro_settings add column if not exists daily_target_value smallint not null default 4 check (daily_target_value between 1 and 240);
alter table public.pomodoro_sessions add column if not exists client_id text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pomodoro_sessions_owner_client_unique') then
    alter table public.pomodoro_sessions add constraint pomodoro_sessions_owner_client_unique unique (owner_user_id, client_id);
  end if;
end $$;

create index if not exists tasks_user_planned_range_idx on public.tasks(user_id, planned_start, planned_end) where archived_at is null;
create index if not exists tasks_user_dependency_idx on public.tasks(user_id, dependency_task_id) where dependency_task_id is not null;
create index if not exists calendar_entries_owner_range_idx on public.calendar_entries(owner_user_id, starts_at, ends_at) where status <> 'cancelled';
create index if not exists recurrence_rules_owner_entry_idx on public.recurrence_rules(owner_user_id, calendar_entry_id);
create index if not exists pomodoro_sessions_owner_completed_idx on public.pomodoro_sessions(owner_user_id, completed_at desc) where status = 'completed';
