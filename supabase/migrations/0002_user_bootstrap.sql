create or replace function public.bootstrap_myplan_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_workflow_id uuid;
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, 'myplan user'), '@', 1))
  )
  on conflict (id) do update set email = excluded.email;

  insert into public.workflows (owner_user_id, name, is_default)
  values (new.id, 'My workflow', true)
  returning id into default_workflow_id;

  insert into public.workflow_statuses (owner_user_id, workflow_id, name, category, position)
  values
    (new.id, default_workflow_id, 'Backlog', 'backlog', 0),
    (new.id, default_workflow_id, 'Planned', 'planned', 1),
    (new.id, default_workflow_id, 'In progress', 'in_progress', 2),
    (new.id, default_workflow_id, 'Blocked', 'blocked', 3),
    (new.id, default_workflow_id, 'Completed', 'completed', 4),
    (new.id, default_workflow_id, 'Cancelled', 'cancelled', 5),
    (new.id, default_workflow_id, 'Archived', 'archived', 6);

  return new;
end;
$$;

create trigger bootstrap_myplan_user_after_signup
after insert on auth.users
for each row execute function public.bootstrap_myplan_user();
