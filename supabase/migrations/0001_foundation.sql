create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  timezone text not null default 'Asia/Bangkok',
  theme text not null default 'jade' check (theme in ('jade', 'sapphire', 'ink', 'paper')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id uuid,
  title text not null check (length(trim(title)) between 1 and 200),
  description text,
  horizon text,
  starts_on date,
  ends_on date,
  progress smallint not null default 0 check (progress between 0 and 100),
  status text not null default 'active' check (status in ('active', 'completed', 'archived')),
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (parent_id, owner_user_id) references public.goals(id, owner_user_id) on delete set null,
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table public.workflow_statuses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workflow_id uuid not null,
  name text not null,
  category text not null check (category in ('backlog', 'planned', 'in_progress', 'blocked', 'waiting', 'completed', 'cancelled', 'archived')),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (workflow_id, category),
  foreign key (workflow_id, owner_user_id) references public.workflows(id, owner_user_id) on delete cascade
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_task_id uuid,
  workflow_status_id uuid not null,
  previous_status_id uuid,
  title text not null check (length(trim(title)) between 1 and 240),
  description text,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_at timestamptz,
  position numeric not null default 0,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (parent_task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade,
  foreign key (workflow_status_id, owner_user_id) references public.workflow_statuses(id, owner_user_id),
  foreign key (previous_status_id, owner_user_id) references public.workflow_statuses(id, owner_user_id),
  check (parent_task_id is null or parent_task_id <> id)
);

create table public.task_goal_links (
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null,
  goal_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (task_id, goal_id),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade,
  foreign key (goal_id, owner_user_id) references public.goals(id, owner_user_id) on delete cascade
);

create table public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null,
  title text not null check (length(trim(title)) between 1 and 240),
  is_completed boolean not null default false,
  position integer not null default 0 check (position >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (task_id, owner_user_id) references public.tasks(id, owner_user_id) on delete cascade
);

create index goals_owner_parent_idx on public.goals(owner_user_id, parent_id);
create index tasks_owner_due_at_idx on public.tasks(owner_user_id, due_at);
create index tasks_owner_status_idx on public.tasks(owner_user_id, workflow_status_id);
create index checklist_owner_task_position_idx on public.task_checklist_items(owner_user_id, task_id, position);

alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.workflows enable row level security;
alter table public.workflow_statuses enable row level security;
alter table public.tasks enable row level security;
alter table public.task_goal_links enable row level security;
alter table public.task_checklist_items enable row level security;

create policy profiles_own_rows on public.profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy goals_own_rows on public.goals for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy workflows_own_rows on public.workflows for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy workflow_statuses_own_rows on public.workflow_statuses for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy tasks_own_rows on public.tasks for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy task_goal_links_own_rows on public.task_goal_links for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy checklist_own_rows on public.task_checklist_items for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

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

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();
create trigger goals_touch_updated_at before update on public.goals
for each row execute function public.touch_updated_at();
create trigger workflows_touch_updated_at before update on public.workflows
for each row execute function public.touch_updated_at();
create trigger workflow_statuses_touch_updated_at before update on public.workflow_statuses
for each row execute function public.touch_updated_at();
create trigger tasks_touch_updated_at before update on public.tasks
for each row execute function public.touch_updated_at();
create trigger checklist_touch_updated_at before update on public.task_checklist_items
for each row execute function public.touch_updated_at();
