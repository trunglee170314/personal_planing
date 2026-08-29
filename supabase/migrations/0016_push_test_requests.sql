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
on public.push_test_requests(requested_at)
where delivered_at is null;

create or replace function public.request_myplan_push_test(target_endpoint text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target_subscription_id uuid;
  request_id uuid;
begin
  if current_user_id is null then
    raise exception 'Sign in before requesting a push test.';
  end if;

  select id into target_subscription_id
  from public.push_subscriptions
  where owner_user_id = current_user_id
    and endpoint = target_endpoint
    and disabled_at is null
  limit 1;

  if target_subscription_id is null then
    raise exception 'Enable notifications on this device first.';
  end if;

  if exists (
    select 1 from public.push_test_requests
    where owner_user_id = current_user_id
      and requested_at > now() - interval '15 seconds'
  ) then
    raise exception 'Wait 15 seconds before sending another push test.';
  end if;

  insert into public.push_test_requests(owner_user_id, subscription_id)
  values (current_user_id, target_subscription_id)
  returning id into request_id;

  return request_id;
end;
$$;

revoke all on function public.request_myplan_push_test(text) from public;
grant execute on function public.request_myplan_push_test(text) to authenticated;
