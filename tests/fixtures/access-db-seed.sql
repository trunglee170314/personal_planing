insert into auth.users(id,email,email_confirmed_at) values
('00000000-0000-4000-8000-000000000001','owner@example.test',now()),
('00000000-0000-4000-8000-000000000002','existing@example.test',now());

-- Simulate optional production-history tables created by early builds. Both
-- links were originally NOT NULL and must be detached, never delete history.
create table public.focus_sessions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  task_id uuid not null references public.tasks(id),
  goal_id uuid not null references public.goals(id)
);
create table public.time_blocks(
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id),
  task_id uuid not null references public.tasks(id),
  goal_id uuid not null references public.goals(id)
);
