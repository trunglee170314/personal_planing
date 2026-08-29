create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  unique (owner_user_id, endpoint),
  check (length(endpoint)<=2048),
  check (length(p256dh)<=512),
  check (length(auth)<=256),
  check (endpoint ~ '^https://([A-Za-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)(/|$)')
);

create table if not exists public.push_delivery_log (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  calendar_entry_id uuid not null references public.calendar_entries(id) on delete cascade,
  occurrence_start timestamptz not null,
  offset_minutes integer not null,
  delivered_at timestamptz not null default now(),
  unique (subscription_id, calendar_entry_id, occurrence_start, offset_minutes)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_delivery_log enable row level security;

create policy push_subscriptions_own_rows on public.push_subscriptions
for all to authenticated
using (owner_user_id=auth.uid()) with check (owner_user_id=auth.uid());

create policy push_delivery_log_own_rows on public.push_delivery_log
for select to authenticated using (owner_user_id=auth.uid());

create index if not exists push_subscriptions_active_owner_idx
on public.push_subscriptions(owner_user_id) where disabled_at is null;

create or replace function public.limit_myplan_push_subscriptions()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if exists (select 1 from public.push_subscriptions
      where owner_user_id=new.owner_user_id and endpoint=new.endpoint) then
    return new;
  end if;
  if (select count(*) from public.push_subscriptions
      where owner_user_id=new.owner_user_id and disabled_at is null)>=8 then
    raise exception 'This account already has 8 active notification devices.';
  end if;
  return new;
end;
$$;
drop trigger if exists push_subscriptions_limit_active on public.push_subscriptions;
create trigger push_subscriptions_limit_active before insert on public.push_subscriptions
for each row execute function public.limit_myplan_push_subscriptions();

create or replace function public.get_due_push_jobs(check_at timestamptz)
returns table(
  subscription_id uuid,
  owner_user_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  calendar_entry_id uuid,
  occurrence_start timestamptz,
  offset_minutes integer,
  item_type text
)
language sql
security definer
set search_path=''
as $$
with entry_rules as (
  select e.*, r.rrule,
    coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
    case
      when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
      when r.rrule like '%FREQ=WEEKLY%' then 'weekly'
      when r.rrule is not null then 'daily'
      else 'none'
    end as frequency,
    case when r.rrule like '%UNTIL=%' then
      to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],'YYYYMMDD"T"HH24MISS"Z"')
    end as until_at
  from public.calendar_entries e
  left join public.recurrence_rules r on r.calendar_entry_id=e.id
  where e.status<>'cancelled' and e.completed_at is null and e.not_needed_at is null
), starts as (
  select er.*,
    greatest(0, case er.frequency
      when 'daily' then floor(extract(epoch from ((check_at-interval '3 minutes')-er.starts_at))/(86400*er.step))::integer-1
      when 'weekly' then floor(extract(epoch from ((check_at-interval '3 minutes')-er.starts_at))/(604800*er.step))::integer-1
      when 'monthly' then floor(((extract(year from age(check_at,er.starts_at))*12)+extract(month from age(check_at,er.starts_at)))/er.step)::integer-1
      else 0 end) as first_n
  from entry_rules er
), occurrences as (
  select s.*,
    case s.frequency
      when 'daily' then s.starts_at + make_interval(days => n*s.step)
      when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
      when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step)
      else s.starts_at
    end as original_start
  from starts s
  cross join lateral generate_series(s.first_n,case when s.frequency='none' then s.first_n else s.first_n+4 end) n
), effective as (
  select o.*, coalesce(st.override_starts_at,o.original_start) as shown_start,
    st.completed_at as occurrence_completed_at,st.not_needed_at as occurrence_not_needed_at
  from occurrences o
  left join public.calendar_occurrence_states st
    on st.calendar_entry_id=o.id and st.occurrence_start=o.original_start
  where (o.until_at is null or o.original_start<=o.until_at)
)
select ps.id,ps.owner_user_id,ps.endpoint,ps.p256dh,ps.auth,
  e.id,e.original_start,offset_value,e.item_type
from effective e
join public.push_subscriptions ps on ps.owner_user_id=e.owner_user_id and ps.disabled_at is null
cross join lateral unnest(e.notification_offsets) offset_value
where e.occurrence_completed_at is null and e.occurrence_not_needed_at is null
  and e.shown_start-offset_value*interval '1 minute'<=check_at
  and e.shown_start-offset_value*interval '1 minute'>check_at-interval '3 minutes'
  and not exists (
    select 1 from public.push_delivery_log d
    where d.subscription_id=ps.id and d.calendar_entry_id=e.id
      and d.occurrence_start=e.original_start and d.offset_minutes=offset_value
  )
limit 500;
$$;

revoke all on function public.get_due_push_jobs(timestamptz) from public;
grant execute on function public.get_due_push_jobs(timestamptz) to service_role;
