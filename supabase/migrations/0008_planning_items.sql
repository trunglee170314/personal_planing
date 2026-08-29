-- Additive schema for the unified checklist/reminder calendar and Timeline
-- milestones. Existing rows keep their values and become checklist items by
-- default; no existing dates or account preferences are rewritten.

alter table public.goals
  add column if not exists color_key text not null default 'jade';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'goals_color_key_check') then
    alter table public.goals add constraint goals_color_key_check
      check (color_key in ('jade','teal','sky','sapphire','indigo','plum','amber','terracotta'));
  end if;
end $$;

alter table public.tasks add column if not exists link_url text;
alter table public.tasks add column if not exists link_label text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_link_url_check') then
    alter table public.tasks add constraint tasks_link_url_check
      check (link_url is null or link_url ~ '^https?://');
  end if;
end $$;

alter table public.calendar_entries
  add column if not exists item_type text not null default 'checklist';
alter table public.calendar_entries
  add column if not exists completed_at timestamptz;
alter table public.calendar_entries
  add column if not exists not_needed_at timestamptz;
alter table public.calendar_entries
  add column if not exists notification_offsets integer[] not null default array[15];
alter table public.calendar_entries
  add column if not exists is_pinned boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_entries_item_type_check') then
    alter table public.calendar_entries add constraint calendar_entries_item_type_check
      check (item_type in ('checklist','reminder'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_entries_notification_offsets_check') then
    alter table public.calendar_entries add constraint calendar_entries_notification_offsets_check
      check (notification_offsets <@ array[0,5,15,60,1440]);
  end if;
end $$;

create index if not exists calendar_entries_owner_items_range_idx
  on public.calendar_entries(owner_user_id, item_type, starts_at)
  where status <> 'cancelled';
create index if not exists calendar_entries_owner_overdue_idx
  on public.calendar_entries(owner_user_id, starts_at)
  where item_type = 'reminder' and completed_at is null and not_needed_at is null;

create table if not exists public.timeline_milestones (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  goal_id uuid references public.goals(id) on delete set null,
  title text not null check (length(trim(title)) between 1 and 200),
  milestone_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create index if not exists timeline_milestones_owner_date_idx
  on public.timeline_milestones(owner_user_id, milestone_on);

alter table public.timeline_milestones enable row level security;
drop policy if exists timeline_milestones_own_rows on public.timeline_milestones;
create policy timeline_milestones_own_rows on public.timeline_milestones
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

-- Some early hosted instances were provisioned before the shared trigger
-- helper was installed. Keep this migration independently repeatable.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists timeline_milestones_touch_updated_at on public.timeline_milestones;
create trigger timeline_milestones_touch_updated_at
before update on public.timeline_milestones
for each row execute function public.touch_updated_at();
