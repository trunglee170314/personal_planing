-- Additive migration. Existing users keep access; new users await approval.
-- No user content is removed. Limits and log retention remain unset until an
-- administrator explicitly configures them. Apply before enabling the new UI.
begin;

create schema if not exists myplan_private;
revoke all on schema myplan_private from public, anon, authenticated;

create table myplan_private.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','suspended')),
  is_admin boolean not null default false,
  record_limit integer check (record_limit between 1 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_admin or status='approved')
);
create table myplan_private.access_settings (
  id boolean primary key default true check (id),
  default_record_limit integer check (default_record_limit between 1 and 1000000),
  log_retention_days integer check (log_retention_days between 7 and 365)
);
alter table myplan_private.members enable row level security;
alter table myplan_private.access_settings enable row level security;
insert into myplan_private.access_settings(id) values(true);
insert into myplan_private.members(user_id,status)
select id,'approved' from auth.users;

create function myplan_private.register_member()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into myplan_private.members(user_id,record_limit)
  select new.id,default_record_limit from myplan_private.access_settings;
  return new;
end;
$$;
create trigger zz_myplan_register_member after insert on auth.users
for each row execute function myplan_private.register_member();

create function public.myplan_is_approved()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from myplan_private.members
    where user_id=(select auth.uid()) and status='approved');
$$;
create function myplan_private.require_admin()
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from myplan_private.members
    where user_id=auth.uid() and is_admin and status='approved') then
    raise exception 'Administrator access required.' using errcode='42501';
  end if;
end;
$$;

-- Never use editable user metadata, a browser secret, or "first signup wins".
-- This one-time operation is intentionally restricted to the database operator.
create function public.bootstrap_myplan_admin(confirmed_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare target uuid; matches integer;
begin
  select count(*),min(id::text)::uuid into matches,target from auth.users
  where lower(email)=lower(trim(confirmed_email)) and email_confirmed_at is not null;
  if matches<>1 then raise exception 'Expected exactly one verified account for the confirmed admin email.'; end if;
  update myplan_private.members set is_admin=true,status='approved',updated_at=now()
  where user_id=target;
  return target;
end;
$$;
revoke all on function public.bootstrap_myplan_admin(text) from public,anon,authenticated;
grant execute on function public.bootstrap_myplan_admin(text) to service_role;

create function myplan_private.record_count(target uuid)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare tab text; owner_col text; total bigint:=0; n bigint;
begin
  foreach tab in array array['goals','tasks','calendar_entries','recurrence_rules',
    'calendar_occurrence_states','timeline_milestones','pomodoro_sessions','reviews','push_subscriptions'] loop
    if to_regclass('public.'||tab) is null then continue; end if;
    owner_col:=case when tab in ('goals','tasks') then 'user_id' else 'owner_user_id' end;
    execute format('select count(*) from public.%I where %I=$1',tab,owner_col) into n using target;
    total:=total+n;
  end loop;
  return total;
end;
$$;

-- Restrictive policies combine with existing ownership policies, rather than
-- granting administrators access to other people's planner content.
-- A write guard also covers legacy SECURITY DEFINER mutation RPCs.
create function myplan_private.guard_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.role()='authenticated' and not public.myplan_is_approved() then
    raise exception 'Your Online workspace is not approved.' using errcode='42501';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create function myplan_private.enforce_record_quota()
returns trigger language plpgsql security definer set search_path='' as $$
declare owner_id uuid; maximum integer;
begin
  owner_id:=(to_jsonb(new)->>tg_argv[0])::uuid;
  -- Serialize inserts for this owner. AFTER INSERT avoids charging upserts
  -- which resolved to an UPDATE and rolls the entire insert back on failure.
  select record_limit into maximum from myplan_private.members
    where user_id=owner_id for update;
  if maximum is not null and myplan_private.record_count(owner_id)>maximum then
    raise exception 'Workspace record limit reached. Remove unwanted records permanently or ask your administrator to increase the limit.' using errcode='P0001';
  end if;
  return new;
end;
$$;
do $$
declare tab record;
begin
  for tab in
    select t.table_name,
      case when exists(select 1 from information_schema.columns c
        where c.table_schema='public' and c.table_name=t.table_name and c.column_name='owner_user_id')
        then 'owner_user_id' else 'user_id' end as owner_col
    from information_schema.tables t where t.table_schema='public' and t.table_type='BASE TABLE'
      and (t.table_name='profiles' or exists(select 1 from information_schema.columns c
        where c.table_schema='public' and c.table_name=t.table_name and c.column_name in ('owner_user_id','user_id')))
  loop
    execute format('alter table public.%I enable row level security',tab.table_name);
    execute format('create policy myplan_approved_access on public.%I as restrictive for all to authenticated using ((select public.myplan_is_approved())) with check ((select public.myplan_is_approved()))',tab.table_name);
    execute format('create trigger myplan_guard_write before insert or update or delete on public.%I for each row execute function myplan_private.guard_write()',tab.table_name);
    if tab.table_name=any(array['goals','tasks','calendar_entries','recurrence_rules',
      'calendar_occurrence_states','timeline_milestones','pomodoro_sessions','reviews','push_subscriptions']) then
      execute format('create trigger myplan_record_quota after insert on public.%I for each row execute function myplan_private.enforce_record_quota(%L)',tab.table_name,tab.owner_col);
    end if;
  end loop;
end;
$$;

create function public.get_myplan_access()
returns jsonb language sql volatile security definer set search_path='' as $$
  select jsonb_build_object('user_id',m.user_id,'email',u.email,'status',m.status,
    'is_admin',m.is_admin,'record_limit',m.record_limit)
  from myplan_private.members m join auth.users u on u.id=m.user_id
  where m.user_id=(select auth.uid());
$$;
create function public.admin_myplan_users(page_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform myplan_private.require_admin();
  return (select coalesce(jsonb_agg(row),'[]'::jsonb) from (
    select m.user_id,u.email,m.status,m.is_admin,m.record_limit,m.created_at,
      myplan_private.record_count(m.user_id) as records_used
    from myplan_private.members m join auth.users u on u.id=m.user_id
    order by (m.status='pending') desc,m.created_at desc,m.user_id
    limit 50 offset greatest(0,least(page_offset,1000000))
  ) row);
end;
$$;
create function public.admin_myplan_update_user(target_user uuid,next_status text,next_limit integer)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform myplan_private.require_admin();
  if next_status not in ('approved','rejected','suspended') or next_status is null then
    raise exception 'Invalid account status.';
  end if;
  if exists(select 1 from myplan_private.members where user_id=target_user and is_admin)
    and next_status<>'approved' then raise exception 'An administrator cannot be suspended or rejected.'; end if;
  if next_status='approved' and not exists(select 1 from auth.users
    where id=target_user and email_confirmed_at is not null) then
    raise exception 'The user must verify their email before approval.';
  end if;
  update myplan_private.members set status=next_status,record_limit=next_limit,updated_at=now()
  where user_id=target_user;
  if not found then raise exception 'Account not found.'; end if;
end;
$$;
create function public.admin_myplan_settings()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform myplan_private.require_admin();
  return (select to_jsonb(s)-'id' from myplan_private.access_settings s);
end;
$$;
create function public.admin_myplan_save_settings(default_limit integer,retention_days integer)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform myplan_private.require_admin();
  update myplan_private.access_settings set default_record_limit=default_limit,
    log_retention_days=retention_days where id;
end;
$$;

-- Cleanup is opt-in, capped per run, and never deletes planner content.
create function public.cleanup_myplan_push_logs()
returns integer language plpgsql security definer set search_path='' as $$
declare days integer; removed integer;
begin
  select log_retention_days into days from myplan_private.access_settings where id;
  if days is null then return 0; end if;
  delete from public.push_delivery_log where id in (
    select id from public.push_delivery_log
    where delivered_at<now()-make_interval(days=>days)
    order by delivered_at limit 1000);
  get diagnostics removed=row_count;
  return removed;
end;
$$;
revoke all on all functions in schema myplan_private from public,anon,authenticated;
revoke all on function public.myplan_is_approved(),public.get_myplan_access(),
  public.admin_myplan_users(integer),public.admin_myplan_update_user(uuid,text,integer),
  public.admin_myplan_settings(),public.admin_myplan_save_settings(integer,integer),
  public.cleanup_myplan_push_logs() from public,anon,authenticated;
grant execute on function public.myplan_is_approved(),public.get_myplan_access(),
  public.admin_myplan_users(integer),public.admin_myplan_update_user(uuid,text,integer),
  public.admin_myplan_settings(),public.admin_myplan_save_settings(integer,integer) to authenticated;
grant execute on function public.cleanup_myplan_push_logs() to service_role;

notify pgrst,'reload schema';
commit;
