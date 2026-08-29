-- Bootstrap an isolated workspace for every Supabase Auth user.
-- This function supports both the original repository schema and the current
-- production schema, whose workflow status column is named status_key.
create or replace function public.bootstrap_myplan_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_workflow_id uuid;
  display_name_value text;
  uses_status_key boolean;
begin
  display_name_value := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    split_part(coalesce(new.email, 'myplan user'), '@', 1)
  );

  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), display_name_value)
  on conflict (id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        updated_at = now();

  select id into default_workflow_id
  from public.workflows
  where owner_user_id = new.id and is_default
  order by created_at
  limit 1;

  if default_workflow_id is null then
    insert into public.workflows (owner_user_id, name, is_default)
    values (new.id, 'My workflow', true)
    returning id into default_workflow_id;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workflow_statuses'
      and column_name = 'status_key'
  ) into uses_status_key;

  if uses_status_key then
    execute $statuses$
      insert into public.workflow_statuses
        (owner_user_id, workflow_id, name, status_key, position, is_completed)
      select $1, $2, seed.name, seed.status_key, seed.position, seed.is_completed
      from (values
        ('Backlog', 'backlog', 0, false),
        ('Planned', 'planned', 1, false),
        ('In progress', 'in_progress', 2, false),
        ('Blocked', 'blocked', 3, false),
        ('Completed', 'completed', 4, true),
        ('Cancelled', 'cancelled', 5, false)
      ) as seed(name, status_key, position, is_completed)
      where not exists (
        select 1 from public.workflow_statuses existing
        where existing.workflow_id = $2 and existing.status_key = seed.status_key
      )
    $statuses$ using new.id, default_workflow_id;
  else
    execute $statuses$
      insert into public.workflow_statuses
        (owner_user_id, workflow_id, name, category, position)
      select $1, $2, seed.name, seed.category, seed.position
      from (values
        ('Backlog', 'backlog', 0),
        ('Planned', 'planned', 1),
        ('In progress', 'in_progress', 2),
        ('Blocked', 'blocked', 3),
        ('Completed', 'completed', 4),
        ('Cancelled', 'cancelled', 5),
        ('Archived', 'archived', 6)
      ) as seed(name, category, position)
      where not exists (
        select 1 from public.workflow_statuses existing
        where existing.workflow_id = $2 and existing.category = seed.category
      )
    $statuses$ using new.id, default_workflow_id;
  end if;

  if to_regclass('public.pomodoro_settings') is not null then
    execute 'insert into public.pomodoro_settings (owner_user_id) values ($1) on conflict (owner_user_id) do nothing'
      using new.id;
  end if;

  if to_regclass('public.notification_preferences') is not null then
    execute 'insert into public.notification_preferences (owner_user_id) values ($1) on conflict (owner_user_id) do nothing'
      using new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists bootstrap_myplan_user_after_signup on auth.users;
create trigger bootstrap_myplan_user_after_signup
after insert on auth.users
for each row execute function public.bootstrap_myplan_user();
