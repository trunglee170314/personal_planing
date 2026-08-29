-- Finite sparse Checklists. Dates are offsets from the Vietnam-day anchor,
-- retaining one shared entry/annotation target and stable per-occurrence state.
begin;
create function myplan_private.selected_date_offsets(rule text) returns integer[]
language sql immutable set search_path='' as $$
  select string_to_array(substring(rule from '(?:^|;)X-MYPLAN-DATES=([0-9,]+)(?:;|$)'),',')::integer[];
$$;
create function myplan_private.validate_selected_rule(rule text,start_at timestamptz,end_at timestamptz,kind text) returns void
language plpgsql immutable set search_path='' as $$
declare offsets integer[]; last_day date;
begin
  if rule is null or rule not like '%X-MYPLAN-DATES%' then return; end if;
  if length(rule)>4096 or rule !~ '^FREQ=DAILY;INTERVAL=1;UNTIL=[0-9]{8}T235959Z;X-MYPLAN-DATES=0(,[1-9][0-9]{0,4})*$'
    then raise exception 'Invalid selected-date rule.'; end if;
  offsets:=myplan_private.selected_date_offsets(rule);
  if cardinality(offsets) not between 1 and 366 or exists(select 1 from generate_subscripts(offsets,1) i where i>1 and offsets[i]<=offsets[i-1])
    then raise exception 'Choose between 1 and 366 unique dates.'; end if;
  if kind not in ('checklist','reminder') or end_at<=start_at or (kind='checklist' and (start_at at time zone 'Asia/Ho_Chi_Minh')::date<>(end_at at time zone 'Asia/Ho_Chi_Minh')::date) or (kind='reminder' and end_at<>start_at+interval '15 minutes')
    then raise exception 'Selected-date Checklists need a time range within one Vietnam day.'; end if;
  last_day:=(start_at at time zone 'Asia/Ho_Chi_Minh')::date+offsets[cardinality(offsets)];
  if (start_at at time zone 'Asia/Ho_Chi_Minh')::date<'2000-01-01' or last_day>'2200-12-31' or to_char(last_day,'YYYYMMDD')<>substring(rule from 'UNTIL=([0-9]{8})')
    then raise exception 'Selected dates must match the schedule horizon (2000–2200).'; end if;
end $$;
create function myplan_private.check_selected_rule() returns trigger
language plpgsql security definer set search_path='' as $$
declare entry public.calendar_entries;
begin
  -- Undo restores the verified before-image across entry/rule rows in reverse
  -- receipt order; an intermediate anchor may not match until both are restored.
  if current_setting('myplan.undo_replaying',true)='true' then return new; end if;
  select * into entry from public.calendar_entries where id=new.calendar_entry_id;
  perform myplan_private.validate_selected_rule(new.rrule,entry.starts_at,entry.ends_at,entry.item_type);
  return new;
end $$;
create trigger check_selected_rule before insert or update on public.recurrence_rules
for each row execute function myplan_private.check_selected_rule();

create function public.myplan_create_selected_checklist(input jsonb,rule text) returns uuid
language plpgsql security definer set search_path='' as $$
declare new_id uuid; entry public.calendar_entries;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  entry:=jsonb_populate_record(null::public.calendar_entries,input);
  if rule is null or rule not like '%X-MYPLAN-DATES=%' then raise exception 'Choose selected dates.';end if;
  perform myplan_private.validate_selected_rule(rule,entry.starts_at,entry.ends_at,entry.item_type);
  if entry.item_type is distinct from 'checklist' or entry.task_id is null or not exists(select 1 from public.tasks where id=entry.task_id and user_id=auth.uid() and archived_at is null and deleted_at is null) then raise exception 'Choose an active Task for this checklist.';end if;
  if length(btrim(entry.title)) not between 1 and 240 or entry.title is null or entry.timezone<>'Asia/Ho_Chi_Minh' or entry.completed_at is not null or entry.not_needed_at is not null then raise exception 'Invalid selected-date Checklist.';end if;
  insert into public.calendar_entries(owner_user_id,task_id,title,starts_at,ends_at,all_day,timezone,entry_type,flexibility,status,item_type,notification_offsets,is_pinned)
  values(auth.uid(),entry.task_id,entry.title,entry.starts_at,entry.ends_at,false,'Asia/Ho_Chi_Minh','time_block','fixed','planned','checklist',coalesce(entry.notification_offsets,array[15]),coalesce(entry.is_pinned,false)) returning id into new_id;
  insert into public.recurrence_rules(owner_user_id,calendar_entry_id,rrule,timezone) values(auth.uid(),new_id,rule,'Asia/Ho_Chi_Minh');
  perform myplan_private.sync_task_checklists(entry.task_id,true);
  return new_id;
end $$;
revoke all on function public.myplan_create_selected_checklist(jsonb,text) from public,anon;
grant execute on function public.myplan_create_selected_checklist(jsonb,text) to authenticated;

create or replace function myplan_private.sync_task_checklists(target_task uuid,force_empty boolean default false) returns void
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare task_row public.tasks; total integer; resolved integer; done boolean;
begin
  select * into task_row from public.tasks where id=target_task and user_id=auth.uid() for update;
  if not found then return; end if;
  with specs as (
    select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,
      coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
      case when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly' when r.rrule like '%FREQ=WEEKLY%' then 'weekly' when r.rrule is not null then 'daily' else 'none' end as frequency,
      case when r.rrule is not null then to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],'YYYYMMDD"T"HH24MISS"Z"') end as until_at
    from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
    where e.task_id=target_task and e.owner_user_id=auth.uid() and e.item_type='checklist' and e.status<>'cancelled'
  ), occurrences as (
    select s.*,case s.frequency when 'dates' then s.starts_at + make_interval(days => (myplan_private.selected_date_offsets(s.rrule))[n+1]) when 'daily' then s.starts_at+make_interval(days=>n*s.step) when 'weekly' then s.starts_at+make_interval(days=>n*s.step*7) when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step) else s.starts_at end as occurrence_start
    from specs s cross join lateral generate_series(0,case when s.frequency='none' then 0 when s.frequency='dates' then cardinality(myplan_private.selected_date_offsets(s.rrule))-1 else 999 end) n
  ), outcomes as (
    select case when o.frequency='none' or state.calendar_entry_id is null then o.completed_at else state.completed_at end as completed_at,
      case when o.frequency='none' or state.calendar_entry_id is null then o.not_needed_at else state.not_needed_at end as not_needed_at
    from occurrences o left join public.calendar_occurrence_states state on state.calendar_entry_id=o.id and state.owner_user_id=auth.uid() and state.occurrence_start=o.occurrence_start
    where o.frequency='none' or o.occurrence_start<=o.until_at
  ) select count(*),count(*) filter(where completed_at is not null or not_needed_at is not null) into total,resolved from outcomes;
  if total=0 and not force_empty then return; end if;
  done:=total>0 and total=resolved;
  update public.tasks set progress=case when total=0 then 0 else round(resolved*100.0/total)::integer end,
    status=case when done then 'completed' when task_row.status='completed' then coalesce(task_row.previous_status,'planned') else task_row.status end,
    previous_status=case when done then case when task_row.status<>'completed' then task_row.status else task_row.previous_status end else null end,
    completed_at=case when done then coalesce(task_row.completed_at,now()) else null end
    where id=target_task and user_id=auth.uid();
end $$;

create or replace function myplan_private.set_myplan_task_completion(
  target_task_id uuid,
  should_complete boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  task_row public.tasks%rowtype;
  changed_at timestamptz := now();
  next_status text;
  checklist_total integer := 0;
  checklist_resolved integer := 0;
begin
  select * into task_row from public.tasks
  where id=target_task_id and user_id=auth.uid() for update;
  if not found then raise exception 'Task not found.'; end if;
  if (task_row.completed_at is not null)=should_complete then return; end if;

  if should_complete then
    update public.calendar_entries
    set not_needed_at=changed_at,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and completed_at is null
      and not_needed_at is null;

    with specs as (
      select e.id,e.owner_user_id,e.starts_at,r.rrule,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly' else 'daily' end as frequency,
        to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
          'YYYYMMDD"T"HH24MISS"Z"') as until_at
      from public.calendar_entries e join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
      select s.*,
        case s.frequency
          when 'dates' then s.starts_at + make_interval(days => (myplan_private.selected_date_offsets(s.rrule))[n+1])
          when 'daily' then s.starts_at + make_interval(days => n*s.step)
          when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
          else public.myplan_month_occurrence(s.starts_at,n*s.step)
        end as occurrence_start
      from specs s cross join lateral generate_series(0,case when s.frequency='dates' then cardinality(myplan_private.selected_date_offsets(s.rrule))-1 else 999 end) n
    )
    insert into public.calendar_occurrence_states
      (owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,updated_at)
    select owner_user_id,id,occurrence_start,null,changed_at,changed_at
    from occurrences where occurrence_start<=until_at
    on conflict (owner_user_id,calendar_entry_id,occurrence_start) do update
      set not_needed_at=excluded.not_needed_at,updated_at=excluded.updated_at
      where public.calendar_occurrence_states.completed_at is null
        and public.calendar_occurrence_states.not_needed_at is null;

    update public.tasks set
      previous_status=case when status='completed' then previous_status else status end,
      status='completed',completed_at=changed_at,progress=100,updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  else
    update public.calendar_entries set not_needed_at=null,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and not_needed_at=task_row.completed_at;

    update public.calendar_occurrence_states state
    set not_needed_at=null,updated_at=changed_at
    where state.owner_user_id=auth.uid() and state.not_needed_at=task_row.completed_at
      and exists (select 1 from public.calendar_entries entry
        where entry.id=state.calendar_entry_id and entry.task_id=target_task_id
          and entry.item_type='checklist');

    with specs as (
      select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly'
          when r.rrule is not null then 'daily' else 'none' end as frequency,
        case when r.rrule is not null then
          to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
            'YYYYMMDD"T"HH24MISS"Z"') end as until_at
      from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
      select s.*,
        case s.frequency
          when 'dates' then s.starts_at + make_interval(days => (myplan_private.selected_date_offsets(s.rrule))[n+1])
          when 'daily' then s.starts_at + make_interval(days => n*s.step)
          when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
          when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step)
          else s.starts_at
        end as occurrence_start
      from specs s cross join lateral
        generate_series(0,case when s.frequency='none' then 0 when s.frequency='dates' then cardinality(myplan_private.selected_date_offsets(s.rrule))-1 else 999 end) n
    ), outcomes as (
      select coalesce(state.completed_at,o.completed_at) as completed_at,
        coalesce(state.not_needed_at,o.not_needed_at) as not_needed_at
      from occurrences o left join public.calendar_occurrence_states state
        on state.calendar_entry_id=o.id and state.occurrence_start=o.occurrence_start
      where o.frequency='none' or o.occurrence_start<=o.until_at
    )
    select count(*),count(*) filter (
      where completed_at is not null or not_needed_at is not null
    ) into checklist_total,checklist_resolved from outcomes;

    next_status := coalesce(task_row.previous_status,'planned');
    update public.tasks set
      status=case when checklist_total>0 and checklist_resolved=checklist_total
        then 'completed' else next_status end,
      previous_status=case when checklist_total>0 and checklist_resolved=checklist_total
        then next_status else null end,
      completed_at=case when checklist_total>0 and checklist_resolved=checklist_total
        then changed_at else null end,
      progress=case when checklist_total=0 then 0
        else round(checklist_resolved*100.0/checklist_total)::integer end,
      updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  end if;
end;
$$;

create or replace function myplan_private.push_candidates(target_owner uuid,check_at timestamptz)
returns table(job_key text,subscription_id uuid,owner_user_id uuid,endpoint text,p256dh text,auth text,
  calendar_entry_id uuid,occurrence_start timestamptz,offset_minutes integer,item_type text,item_title text,due_at timestamptz)
language sql stable security definer set search_path='' set timezone='UTC' as $$
with rules as (
  select e.*,r.rrule,
    coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
    case when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
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
    when 'dates' then starts_at+make_interval(days=>(myplan_private.selected_date_offsets(s.rrule))[n+1])
    when 'daily' then starts_at+make_interval(days=>n*step)
    when 'weekly' then starts_at+make_interval(days=>n*step*7)
    when 'monthly' then public.myplan_month_occurrence(starts_at,n*step)
    else starts_at end as original_start
  from starts s cross join lateral generate_series(first_n,case when frequency='none' then first_n when frequency='dates' then cardinality(myplan_private.selected_date_offsets(s.rrule))-1 else first_n+5 end) n
  union
  -- Include moved occurrences even when their original date lies outside the
  -- generated horizon. Rechecking before send also cancels stale queued jobs.
  select s.id,st.occurrence_start from rules s join public.calendar_occurrence_states st
    on st.calendar_entry_id=s.id and st.override_starts_at is not null
    and (s.frequency<>'dates' or st.occurrence_start in (select s.starts_at+make_interval(days=>d) from unnest(myplan_private.selected_date_offsets(s.rrule)) d))
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

create or replace function public.get_due_push_jobs_before_approval(check_at timestamptz)
returns table(
  subscription_id uuid,
  owner_user_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  calendar_entry_id uuid,
  occurrence_start timestamptz,
  offset_minutes integer,
  item_type text,
  item_title text
)
language sql
security definer
set search_path=''
set timezone='UTC'
as $$
with entry_rules as (
  select e.*,r.rrule,
    coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
    case
      when r.rrule like '%X-MYPLAN-DATES=%' then 'dates'
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
    greatest(0,case er.frequency
      when 'daily' then floor(extract(epoch from ((check_at-interval '3 minutes')-er.starts_at))/(86400*er.step))::integer-1
      when 'weekly' then floor(extract(epoch from ((check_at-interval '3 minutes')-er.starts_at))/(604800*er.step))::integer-1
      when 'monthly' then floor(((extract(year from age(check_at,er.starts_at))*12)+extract(month from age(check_at,er.starts_at)))/er.step)::integer-1
      else 0 end) as first_n
  from entry_rules er
), occurrences as (
  select s.*,
    case s.frequency
      when 'dates' then s.starts_at + make_interval(days => (myplan_private.selected_date_offsets(s.rrule))[n+1])
      when 'daily' then s.starts_at+make_interval(days=>n*s.step)
      when 'weekly' then s.starts_at+make_interval(days=>n*s.step*7)
      when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step)
      else s.starts_at
    end as original_start
  from starts s
  cross join lateral generate_series(
    s.first_n,
    case when s.frequency='none' then s.first_n when s.frequency='dates' then cardinality(myplan_private.selected_date_offsets(s.rrule))-1 else s.first_n+4 end
  ) n
), effective as (
  select o.*,coalesce(st.override_starts_at,o.original_start) as shown_start,
    st.completed_at as occurrence_completed_at,
    st.not_needed_at as occurrence_not_needed_at
  from occurrences o
  left join public.calendar_occurrence_states st
    on st.calendar_entry_id=o.id and st.occurrence_start=o.original_start
  where o.until_at is null or o.original_start<=o.until_at
)
select ps.id,ps.owner_user_id,ps.endpoint,ps.p256dh,ps.auth,
  e.id,e.original_start,offset_value,e.item_type,e.title
from effective e
join public.push_subscriptions ps
  on ps.owner_user_id=e.owner_user_id and ps.disabled_at is null
cross join lateral unnest(e.notification_offsets) offset_value
where e.occurrence_completed_at is null
  and e.occurrence_not_needed_at is null
  and e.shown_start-offset_value*interval '1 minute'<=check_at
  and e.shown_start-offset_value*interval '1 minute'>check_at-interval '3 minutes'
  and not exists (
    select 1 from public.push_delivery_log d
    where d.subscription_id=ps.id
      and d.calendar_entry_id=e.id
      and d.occurrence_start=e.original_start
      and d.offset_minutes=offset_value
  )
limit 500;
$$;

create or replace function public.myplan_update_calendar_entry(target_entry uuid,changes jsonb,next_rule text,rule_changed boolean default false,expected_rule text default null,expected_entry jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare original public.calendar_entries; patched public.calendar_entries; field text; old_rule text; pattern_changed boolean;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into original from public.calendar_entries where id=target_entry and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  select rrule into old_rule from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
  if rule_changed and old_rule is distinct from expected_rule then raise exception 'This repeat rule changed. Reopen the item before saving.';end if;
  if expected_entry is not null then
    for field in select jsonb_object_keys(changes) loop
      if to_jsonb(original)->field is distinct from to_jsonb(jsonb_populate_record(original,expected_entry))->field then raise exception 'This calendar item changed. Reopen it before saving.';end if;
    end loop;
  end if;
  for field in select jsonb_object_keys(changes) loop
    if field not in ('title','task_id','starts_at','ends_at','all_day','timezone','item_type','completed_at','not_needed_at','notification_offsets','is_pinned') then raise exception 'Unsupported calendar field: %',field;end if;
  end loop;
  patched:=jsonb_populate_record(original,changes);
  if expected_entry is not null and (patched.starts_at is distinct from original.starts_at or patched.ends_at is distinct from original.ends_at) and old_rule is distinct from expected_rule then raise exception 'This repeat rule changed. Reopen the item before moving it.';end if;
  if length(btrim(patched.title)) not between 1 and 240 or patched.ends_at<=patched.starts_at or patched.starts_at<'2000-01-01' or patched.ends_at>='2201-01-01' then raise exception 'Enter a title and valid time range (2000–2200).';end if;
  if patched.item_type='checklist' and patched.task_id is null then raise exception 'Choose a Task for this checklist.';end if;
  if patched.completed_at is not null and patched.not_needed_at is not null then raise exception 'Choose Done or Not needed, not both.';end if;
  if not rule_changed then next_rule:=old_rule;end if;
  if next_rule is not null and (length(next_rule)>4096 or next_rule!~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;|$)') then raise exception 'Invalid recurrence rule.';end if;
  if patched.item_type='checklist' and next_rule is not null and next_rule!~ 'UNTIL=[0-9]{8}T[0-9]{6}Z' then raise exception 'Repeating checklist requires an end date.';end if;
  perform myplan_private.validate_selected_rule(next_rule,patched.starts_at,patched.ends_at,patched.item_type);
  pattern_changed:=regexp_replace(coalesce(old_rule,''),';UNTIL=[^;]+','','g') is distinct from regexp_replace(coalesce(next_rule,''),';UNTIL=[^;]+','','g');
  if pattern_changed and (original.completed_at is not null or original.not_needed_at is not null or exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=target_entry and owner_user_id=auth.uid())) then raise exception 'This series has history. Keep its repeat pattern or create a new series.';end if;
  if old_rule is not null and not pattern_changed and (patched.starts_at is distinct from original.starts_at or patched.ends_at is distinct from original.ends_at) then
    perform public.move_calendar_series(target_entry,original.starts_at,original.ends_at,patched.starts_at,patched.ends_at);
  end if;
  update public.calendar_entries set title=patched.title,task_id=patched.task_id,starts_at=patched.starts_at,ends_at=patched.ends_at,all_day=patched.all_day,timezone=patched.timezone,item_type=patched.item_type,completed_at=patched.completed_at,not_needed_at=patched.not_needed_at,notification_offsets=patched.notification_offsets,is_pinned=patched.is_pinned where id=target_entry and owner_user_id=auth.uid();
  select rrule into old_rule from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
  if rule_changed and old_rule is distinct from next_rule then
    delete from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
    if next_rule is not null then insert into public.recurrence_rules(owner_user_id,calendar_entry_id,rrule,timezone) values(auth.uid(),target_entry,next_rule,patched.timezone);end if;
  end if;
  perform myplan_private.sync_task_checklists(original.task_id,true);
  if patched.task_id is distinct from original.task_id then perform myplan_private.sync_task_checklists(patched.task_id,true);end if;
end $$;
create or replace function public.move_calendar_series(target_entry_id uuid,original_occurrence_start timestamptz,original_occurrence_end timestamptz,next_occurrence_start timestamptz,next_occurrence_end timestamptz) returns void language plpgsql security definer set search_path='' as $$
declare entry_row public.calendar_entries;rule_text text;state_rows jsonb;state_row jsonb;old_start timestamptz;new_start timestamptz;anchor timestamptz;month_index integer;step integer;delta_start interval;delta_end interval;old_until date;next_until date;last_index integer;last_day date;next_day date;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into entry_row from public.calendar_entries where id=target_entry_id and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  if original_occurrence_start is null or original_occurrence_end is null or next_occurrence_start is null or next_occurrence_end is null then raise exception 'Invalid series dates.';end if;
  if entry_row.item_type='reminder' then next_occurrence_end:=next_occurrence_start+interval '15 minutes';end if;
  delta_start:=next_occurrence_start-original_occurrence_start;delta_end:=next_occurrence_end-original_occurrence_end;anchor:=entry_row.starts_at+delta_start;
  if anchor<'2000-01-01' or anchor>='2201-01-01' or entry_row.ends_at+delta_end>='2201-01-01' or entry_row.ends_at+delta_end<=anchor then raise exception 'Moved dates must stay between 2000 and 2200.';end if;
  select rrule into rule_text from public.recurrence_rules where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
  if rule_text like 'FREQ=MONTHLY%' then
    step:=coalesce(substring(rule_text from 'INTERVAL=([0-9]+)')::integer,1);
    select coalesce(jsonb_agg(to_jsonb(s)),'[]') into state_rows from public.calendar_occurrence_states s where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
    for state_row in select value from jsonb_array_elements(state_rows) loop
      old_start:=(state_row->>'occurrence_start')::timestamptz;
      month_index:=(extract(year from old_start at time zone 'Asia/Ho_Chi_Minh')-extract(year from entry_row.starts_at at time zone 'Asia/Ho_Chi_Minh'))::integer*12+(extract(month from old_start at time zone 'Asia/Ho_Chi_Minh')-extract(month from entry_row.starts_at at time zone 'Asia/Ho_Chi_Minh'))::integer;
      if month_index<0 or mod(month_index,step)<>0 or public.myplan_month_occurrence(entry_row.starts_at,month_index)<>old_start then raise exception 'This monthly series contains an unmatched history date. Resolve it before moving the series.';end if;
    end loop;
  end if;
  perform myplan_private.move_calendar_series(target_entry_id,original_occurrence_start,original_occurrence_end,next_occurrence_start,next_occurrence_end);
  if state_rows is not null then
    update public.calendar_occurrence_states set occurrence_start=occurrence_start+interval '400 years' where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
    for state_row in select value from jsonb_array_elements(state_rows) loop
      old_start:=(state_row->>'occurrence_start')::timestamptz;
      month_index:=(extract(year from old_start at time zone 'Asia/Ho_Chi_Minh')-extract(year from entry_row.starts_at at time zone 'Asia/Ho_Chi_Minh'))::integer*12+(extract(month from old_start at time zone 'Asia/Ho_Chi_Minh')-extract(month from entry_row.starts_at at time zone 'Asia/Ho_Chi_Minh'))::integer;
      new_start:=public.myplan_month_occurrence(anchor,month_index);
      if new_start<'2000-01-01' or new_start>='2201-01-01' then raise exception 'Moved dates must stay between 2000 and 2200.';end if;
      update public.calendar_occurrence_states set occurrence_start=new_start,override_starts_at=(state_row->>'override_starts_at')::timestamptz+(new_start-old_start),override_ends_at=(state_row->>'override_ends_at')::timestamptz+(new_start-old_start)+delta_end-delta_start where calendar_entry_id=target_entry_id and owner_user_id=auth.uid() and occurrence_start=old_start+delta_start+interval '400 years';
    end loop;
    if rule_text like '%UNTIL=%' then
      old_until:=to_date(substring(rule_text from 'UNTIL=([0-9]{8})'),'YYYYMMDD');
      select max(n) into last_index from generate_series(0,999) n where (public.myplan_month_occurrence(entry_row.starts_at,n*step) at time zone 'Asia/Ho_Chi_Minh')::date<=old_until;
      last_day:=(public.myplan_month_occurrence(anchor,last_index*step) at time zone 'Asia/Ho_Chi_Minh')::date;
      next_day:=(public.myplan_month_occurrence(anchor,(last_index+1)*step) at time zone 'Asia/Ho_Chi_Minh')::date;
      next_until:=least(next_day-1,greatest(last_day,old_until+((next_occurrence_start at time zone 'Asia/Ho_Chi_Minh')::date-(original_occurrence_start at time zone 'Asia/Ho_Chi_Minh')::date)));
      update public.recurrence_rules set rrule=regexp_replace(rrule,'UNTIL=[0-9]{8}','UNTIL='||to_char(next_until,'YYYYMMDD')) where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
    end if;
  end if;
  if exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=target_entry_id and owner_user_id=auth.uid() and (occurrence_start<'2000-01-01' or occurrence_start>='2201-01-01' or override_starts_at<'2000-01-01' or override_ends_at>='2201-01-01' or override_ends_at<=override_starts_at)) then raise exception 'Moved dates must stay between 2000 and 2200.';end if;
  select rrule into rule_text from public.recurrence_rules where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
  perform myplan_private.validate_selected_rule(rule_text,anchor,entry_row.ends_at+delta_end,entry_row.item_type);
  perform myplan_private.sync_task_checklists(entry_row.task_id,true);
end $$;

revoke all on function myplan_private.selected_date_offsets(text),myplan_private.validate_selected_rule(text,timestamptz,timestamptz,text),myplan_private.check_selected_rule() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
