-- Add recoverable trash support for goals and tasks.
-- Archive continues to use goals.status/goals.archived_at and tasks.archived_at.
alter table public.goals add column if not exists deleted_at timestamptz;
alter table public.tasks add column if not exists deleted_at timestamptz;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'goals' and column_name = 'user_id'
  ) then
    execute 'create index if not exists goals_user_lifecycle_idx on public.goals(user_id, deleted_at, status, created_at desc)';
    execute 'create index if not exists tasks_user_lifecycle_idx on public.tasks(user_id, deleted_at, archived_at, created_at desc)';
  else
    execute 'create index if not exists goals_owner_lifecycle_idx on public.goals(owner_user_id, deleted_at, status, created_at desc)';
    execute 'create index if not exists tasks_owner_lifecycle_idx on public.tasks(owner_user_id, deleted_at, archived_at, created_at desc)';
  end if;
end
$$;
