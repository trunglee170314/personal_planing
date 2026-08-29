-- Per-owner schedule reconciliation + leased delivery. No existing log/content
-- is deleted. pg_net is optional for local tests, required for immediate webhooks.
begin;
create table myplan_private.push_dirty (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1,
  dirty boolean not null default true,
  changed_at timestamptz not null default now(),
  last_txid bigint not null default txid_current()
);
create table myplan_private.push_config (
  id boolean primary key default true check(id),
  webhook_secret text check(length(webhook_secret) between 32 and 256)
);
insert into myplan_private.push_config(id) values(true);
create table myplan_private.push_leases (
  job_key text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  token uuid not null,
  expires_at timestamptz not null,
  due_at timestamptz not null,
  attempts integer not null default 1
);
create table myplan_private.push_failures (
  job_key text not null, due_at timestamptz not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  failed_at timestamptz not null default now(), primary key(job_key,due_at)
);
alter table myplan_private.push_dirty enable row level security;
alter table myplan_private.push_config enable row level security;
alter table myplan_private.push_leases enable row level security;
alter table myplan_private.push_failures enable row level security;
create function myplan_private.mark_push_dirty()
returns trigger language plpgsql security definer set search_path='' as $$
declare owner_id uuid; did_change uuid; secret text;
begin
  owner_id := (case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end ->> tg_argv[0])::uuid;
  if not exists(select 1 from auth.users where id=owner_id) then return null; end if;
  insert into myplan_private.push_dirty(owner_user_id) values(owner_id)
  on conflict(owner_user_id) do update set revision=push_dirty.revision+1,
    dirty=true,changed_at=now(),last_txid=txid_current()
    where push_dirty.last_txid<>txid_current() returning owner_user_id into did_change;
  if did_change is not null then
    select webhook_secret into secret from myplan_private.push_config;
    if secret is not null and to_regnamespace('net') is not null then
      begin
        execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 3000)'
        using 'https://myplan-push.trungvanle.workers.dev/schedule-hook',
          jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),
          jsonb_build_object('owner_user_id',owner_id);
      exception when others then
        -- A notification outage must not fail the user's edit. Cron reconciles
        -- this durable dirty marker if the webhook cannot be delivered.
        raise warning 'Push wakeup unavailable; queued for reconciliation.';
      end;
    end if;
  end if;
  return null;
end;
$$;
do $$ declare tab text; begin
  foreach tab in array array['calendar_entries','recurrence_rules','calendar_occurrence_states','push_subscriptions'] loop
    execute format('create trigger myplan_push_dirty after insert or update or delete on public.%I for each row execute function myplan_private.mark_push_dirty(''owner_user_id'')',tab);
  end loop;
end $$;
create trigger myplan_member_push_dirty after insert or update on myplan_private.members
for each row execute function myplan_private.mark_push_dirty('user_id');
insert into myplan_private.push_dirty(owner_user_id) select user_id from myplan_private.members;

create function public.configure_myplan_push_webhook(shared_secret text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if to_regnamespace('net') is null then raise exception 'Enable the pg_net extension before configuring push webhooks.'; end if;
  update myplan_private.push_config set webhook_secret=shared_secret;
  update myplan_private.push_dirty set dirty=true,revision=revision+1,changed_at=now();
end;
$$;

create function myplan_private.push_candidates(target_owner uuid,check_at timestamptz)
returns table(job_key text,subscription_id uuid,owner_user_id uuid,endpoint text,p256dh text,auth text,
  calendar_entry_id uuid,occurrence_start timestamptz,offset_minutes integer,item_type text,item_title text,due_at timestamptz)
language sql stable security definer set search_path='' set timezone='UTC' as $$
with rules as (
  select e.*,r.rrule,
    coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
    case when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
      when r.rrule like '%FREQ=WEEKLY%' then 'weekly'
      when r.rrule is not null then 'daily' else 'none' end as frequency,
    case when r.rrule like '%UNTIL=%' then to_timestamp(
      (regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],'YYYYMMDD"T"HH24MISS"Z"') end as until_at
  from public.calendar_entries e
  join myplan_private.members m on m.user_id=e.owner_user_id and m.status='approved'
  left join public.recurrence_rules r on r.calendar_entry_id=e.id
  where e.owner_user_id=target_owner and e.status<>'cancelled'
    and e.completed_at is null and e.not_needed_at is null
), starts as (
  select r.*,greatest(0,case frequency
    when 'daily' then floor(extract(epoch from ((check_at-interval '1 day')-starts_at))/(86400*step))::integer-1
    when 'weekly' then floor(extract(epoch from ((check_at-interval '1 day')-starts_at))/(604800*step))::integer-1
    when 'monthly' then floor((extract(year from age(check_at-interval '1 day',starts_at))*12+extract(month from age(check_at-interval '1 day',starts_at)))/step)::integer-1
    else 0 end) as first_n from rules r
), generated as (
  select s.id,case frequency
    when 'daily' then starts_at+make_interval(days=>n*step)
    when 'weekly' then starts_at+make_interval(days=>n*step*7)
    when 'monthly' then public.myplan_month_occurrence(starts_at,n*step)
    else starts_at end as original_start
  from starts s cross join lateral generate_series(first_n,case when frequency='none' then first_n else first_n+5 end) n
  union
  -- Include moved occurrences even when their original date lies outside the
  -- generated horizon. Rechecking before send also cancels stale queued jobs.
  select s.id,st.occurrence_start from rules s join public.calendar_occurrence_states st
    on st.calendar_entry_id=s.id and st.override_starts_at is not null
), effective as (
  select r.*,g.original_start,coalesce(st.override_starts_at,g.original_start) as shown_start,
    st.completed_at as occurrence_completed_at,st.not_needed_at as occurrence_not_needed_at
  from generated g join rules r on r.id=g.id left join public.calendar_occurrence_states st
    on st.calendar_entry_id=g.id and st.occurrence_start=g.original_start
  where r.until_at is null or g.original_start<=r.until_at
)
select md5(ps.id::text||':'||e.id::text||':'||extract(epoch from e.original_start)::text||':'||o::text),
  ps.id,ps.owner_user_id,ps.endpoint,ps.p256dh,ps.auth,e.id,e.original_start,o,e.item_type,e.title,
  e.shown_start-o*interval '1 minute'
from effective e join public.push_subscriptions ps on ps.owner_user_id=e.owner_user_id and ps.disabled_at is null
cross join lateral unnest(e.notification_offsets) o
where e.occurrence_completed_at is null and e.occurrence_not_needed_at is null
  and e.shown_start-o*interval '1 minute'>check_at-interval '1 day'
  and not exists(select 1 from myplan_private.push_failures f where
    f.job_key=md5(ps.id::text||':'||e.id::text||':'||extract(epoch from e.original_start)::text||':'||o::text)
    and f.due_at=e.shown_start-o*interval '1 minute')
  and not exists(select 1 from public.push_delivery_log d where d.subscription_id=ps.id
    and d.calendar_entry_id=e.id and d.occurrence_start=e.original_start and d.offset_minutes=o);
$$;

create function public.get_myplan_push_schedule(target_owner uuid,excluded_keys text[] default '{}')
returns jsonb language sql volatile security definer set search_path='' as $$
  select jsonb_build_object('revision',coalesce((select revision from myplan_private.push_dirty where owner_user_id=target_owner),0),
    'jobs',coalesce((select jsonb_agg(j) from (select job_key,owner_user_id,due_at
      from myplan_private.push_candidates(target_owner,now()) where not(job_key=any(excluded_keys))
      order by due_at,job_key limit 200) j),'[]'::jsonb));
$$;
create function public.myplan_push_reconciled(target_owner uuid,expected_revision bigint)
returns void language sql security definer set search_path='' as $$
  update myplan_private.push_dirty set dirty=false where owner_user_id=target_owner and revision=expected_revision;
$$;
create function public.myplan_dirty_push_owners()
returns setof uuid language sql security definer set search_path='' as $$
  select owner_user_id from myplan_private.push_dirty where dirty order by changed_at,owner_user_id limit 10;
$$;
create function public.claim_myplan_push_job(target_owner uuid,target_key text,expected_due timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job record; lease uuid:=gen_random_uuid(); claimed uuid; attempt_count integer;
begin
  select * into job from myplan_private.push_candidates(target_owner,now())
  where job_key=target_key and due_at=expected_due and due_at<=now();
  if not found then return jsonb_build_object('state','skip'); end if;
  insert into myplan_private.push_leases(job_key,owner_user_id,token,expires_at,due_at)
  values(target_key,target_owner,lease,now()+interval '2 minutes',expected_due)
  on conflict(job_key) do update set token=excluded.token,expires_at=excluded.expires_at,
    due_at=excluded.due_at,attempts=case when push_leases.due_at=excluded.due_at then push_leases.attempts+1 else 1 end
  where push_leases.expires_at<=now() or push_leases.due_at<>excluded.due_at
  returning token,attempts into claimed,attempt_count;
  if claimed is null then return jsonb_build_object('state','busy'); end if;
  if attempt_count>6 then
    insert into myplan_private.push_failures(job_key,due_at,owner_user_id) values(target_key,expected_due,target_owner) on conflict do nothing;
    delete from myplan_private.push_leases where job_key=target_key;
    return jsonb_build_object('state','skip');
  end if;
  return jsonb_build_object('state','ready','token',lease,'job',to_jsonb(job));
end;
$$;
create function public.finish_myplan_push_job(target_key text,lease_token uuid,delivery jsonb,result text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from myplan_private.push_leases where job_key=target_key and token=lease_token for update;
  if not found then return; end if;
  if result='sent' then
    insert into public.push_delivery_log(owner_user_id,subscription_id,calendar_entry_id,occurrence_start,offset_minutes)
    values((delivery->>'owner_user_id')::uuid,(delivery->>'subscription_id')::uuid,
      (delivery->>'calendar_entry_id')::uuid,(delivery->>'occurrence_start')::timestamptz,(delivery->>'offset_minutes')::integer)
    on conflict(subscription_id,calendar_entry_id,occurrence_start,offset_minutes) do nothing;
  elsif result='disabled' then
    update public.push_subscriptions set disabled_at=now() where id=(delivery->>'subscription_id')::uuid;
  elsif result='retry' then
    update myplan_private.push_leases set expires_at=now() where job_key=target_key and token=lease_token;
    return;
  else raise exception 'Invalid delivery result.';
  end if;
  delete from myplan_private.push_leases where job_key=target_key and token=lease_token;
end;
$$;
create function public.myplan_push_owner_approved(target_owner uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from myplan_private.members where user_id=target_owner and status='approved');
$$;
-- The same opt-in retention also covers expired internal delivery metadata.
create or replace function public.cleanup_myplan_push_logs()
returns integer language plpgsql security definer set search_path='' as $$
declare keep_days integer; removed integer; n integer;
begin
  select log_retention_days into keep_days from myplan_private.access_settings where id;
  if keep_days is null then return 0; end if;
  delete from public.push_delivery_log where id in (select id from public.push_delivery_log
    where delivered_at<now()-make_interval(days=>keep_days) order by delivered_at limit 1000);
  get diagnostics removed=row_count;
  delete from myplan_private.push_failures where (job_key,due_at) in
    (select job_key,due_at from myplan_private.push_failures where failed_at<now()-make_interval(days=>keep_days) limit 1000);
  get diagnostics n=row_count; removed:=removed+n;
  delete from myplan_private.push_leases where job_key in
    (select job_key from myplan_private.push_leases where expires_at<now()-make_interval(days=>keep_days) limit 1000);
  get diagnostics n=row_count; return removed+n;
end;
$$;

-- The legacy cron also respects suspension during a staged rollout.
alter function public.get_due_push_jobs(timestamptz) rename to get_due_push_jobs_before_approval;
create function public.get_due_push_jobs(check_at timestamptz)
returns table(subscription_id uuid,owner_user_id uuid,endpoint text,p256dh text,auth text,
  calendar_entry_id uuid,occurrence_start timestamptz,offset_minutes integer,item_type text,item_title text)
language sql security definer set search_path='' as $$
  select j.* from public.get_due_push_jobs_before_approval(check_at) j
  join myplan_private.members m on m.user_id=j.owner_user_id and m.status='approved';
$$;
revoke all on all functions in schema myplan_private from public,anon,authenticated;
revoke all on function public.configure_myplan_push_webhook(text),public.get_myplan_push_schedule(uuid,text[]),
  public.myplan_push_reconciled(uuid,bigint),public.myplan_dirty_push_owners(),
  public.claim_myplan_push_job(uuid,text,timestamptz),public.finish_myplan_push_job(text,uuid,jsonb,text),
  public.myplan_push_owner_approved(uuid),
  public.get_due_push_jobs(timestamptz) from public,anon,authenticated;
grant execute on function public.configure_myplan_push_webhook(text),public.get_myplan_push_schedule(uuid,text[]),
  public.myplan_push_reconciled(uuid,bigint),public.myplan_dirty_push_owners(),
  public.claim_myplan_push_job(uuid,text,timestamptz),public.finish_myplan_push_job(text,uuid,jsonb,text),
  public.myplan_push_owner_approved(uuid),
  public.get_due_push_jobs(timestamptz) to service_role;
notify pgrst,'reload schema';
commit;
