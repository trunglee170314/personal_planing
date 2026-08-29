-- Keep requested repeat rules separate from effective, history-bearing instances.
-- No existing annotation is reassigned: NULL occurrence_state_id = Series notes.
begin;
create function myplan_private.occurrence_reminder_duration() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.item_type='reminder' and old.item_type='checklist' then
    update public.calendar_occurrence_states set override_starts_at=coalesce(override_starts_at,occurrence_start),override_ends_at=coalesce(override_starts_at,occurrence_start)+interval '15 minutes' where calendar_entry_id=new.id;
  end if;
  return null;
end $$;
create trigger occurrence_reminder_duration after update of item_type on public.calendar_entries for each row execute function myplan_private.occurrence_reminder_duration();
revoke all on function myplan_private.occurrence_reminder_duration() from public,anon,authenticated;
alter table public.calendar_entries add column occurrence_mode boolean not null default false;
alter table public.calendar_occurrence_states add column id uuid not null default gen_random_uuid();
alter table public.calendar_occurrence_states add column title_is_exception boolean not null default false;
alter table public.calendar_occurrence_states add column title_override text check(title_override is null or length(btrim(title_override)) between 1 and 240);
alter table public.calendar_occurrence_states add column is_exception boolean not null default false;
update public.calendar_occurrence_states set is_exception=true where override_starts_at is not null or override_ends_at is not null;
alter table public.calendar_occurrence_states add unique(owner_user_id,calendar_entry_id,id);
alter table public.planner_annotations add column occurrence_state_id uuid;
alter table public.planner_annotations add constraint annotation_occurrence_owner foreign key(owner_user_id,calendar_entry_id,occurrence_state_id) references public.calendar_occurrence_states(owner_user_id,calendar_entry_id,id);
alter table public.planner_annotations add constraint annotation_occurrence_calendar check(occurrence_state_id is null or calendar_entry_id is not null);
create index annotation_occurrence on public.planner_annotations(owner_user_id,occurrence_state_id);

create function myplan_private.series_keys(start_at timestamptz,rule text) returns timestamptz[]
language sql stable set search_path='' set timezone='UTC' as $$
  with spec as(select coalesce(substring(rule from 'INTERVAL=([0-9]+)')::integer,1) as step,
    case when rule like '%UNTIL=%' then to_date(substring(rule from 'UNTIL=([0-9]{8})'),'YYYYMMDD') end as last_day),
  starts as(select case when rule like '%X-MYPLAN-DATES=%' then start_at+make_interval(days=>(myplan_private.selected_date_offsets(rule))[n+1])
    when rule like 'FREQ=MONTHLY%' then public.myplan_month_occurrence(start_at,n*greatest(1,step))
    when rule like 'FREQ=WEEKLY%' then start_at+make_interval(days=>n*greatest(1,step)*7)
    else start_at+make_interval(days=>n*greatest(1,step)) end as value,last_day
    from spec cross join lateral generate_series(0,case when rule is null then 0 when rule like '%X-MYPLAN-DATES=%' then cardinality(myplan_private.selected_date_offsets(rule))-1 else 1000 end) n)
  select coalesce(array_agg(value order by value),'{}') from starts where rule is null or last_day is null or (value at time zone 'Asia/Ho_Chi_Minh')::date<=last_day;
$$;
create function myplan_private.effective_keys(entry_id uuid,start_at timestamptz,rule text,materialized boolean) returns timestamptz[]
language sql stable security definer set search_path='' set timezone='UTC' as $$
  select case when materialized then coalesce((select array_agg(occurrence_start order by occurrence_start) from public.calendar_occurrence_states where calendar_entry_id=entry_id),'{}') else (myplan_private.series_keys(start_at,rule))[1:1000] end;
$$;

-- Validate one legacy key mathematically: normal viewport actions must not be
-- limited by the bounded, full-series reconciliation size.
create function myplan_private.is_occurrence(entry_id uuid,start_at timestamptz,rule text,materialized boolean,key timestamptz) returns boolean
language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare step integer; months integer; difference numeric; last_day date;
begin
  if key is null then return false;end if;
  if materialized then return exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry_id and occurrence_start=key);end if;
  if key<start_at then return false;end if;
  if rule is null then return key=start_at;end if;
  if rule like '%UNTIL=%' then last_day:=to_date(substring(rule from 'UNTIL=([0-9]{8})'),'YYYYMMDD');if (key at time zone 'Asia/Ho_Chi_Minh')::date>last_day then return false;end if;end if;
  step:=greatest(1,coalesce(substring(rule from 'INTERVAL=([0-9]+)')::integer,1));
  difference:=extract(epoch from key-start_at);
  if rule like '%X-MYPLAN-DATES=%' then return mod(difference,86400)=0 and (difference/86400)::integer=any(myplan_private.selected_date_offsets(rule));end if;
  if rule like 'FREQ=MONTHLY%' then
    months:=(extract(year from key at time zone 'Asia/Ho_Chi_Minh')-extract(year from start_at at time zone 'Asia/Ho_Chi_Minh'))::integer*12+(extract(month from key at time zone 'Asia/Ho_Chi_Minh')-extract(month from start_at at time zone 'Asia/Ho_Chi_Minh'))::integer;
    return mod(months,step)=0 and public.myplan_month_occurrence(start_at,months)=key;
  end if;
  return mod(difference,86400*step*case when rule like 'FREQ=WEEKLY%' then 7 else 1 end)=0;
end $$;

create function public.myplan_revise_calendar_series(target_entry uuid,input jsonb,next_rule text,scope text,from_start timestamptz,expected_entry jsonb,expected_rule text) returns void
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare original public.calendar_entries; patched public.calendar_entries; expected public.calendar_entries; state public.calendar_occurrence_states;
  old_rule text; keys timestamptz[]; desired timestamptz[]; key timestamptz; shown_start timestamptz; shown_end timestamptz;
  before_cut boolean; protected boolean; had_state boolean; metadata_only boolean; day_key text; field text; row_value jsonb;
  rows jsonb:='[]'; reusable jsonb:='{}'; protected_days text[]:='{}'; retained timestamptz[]:='{}'; duration interval;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into original from public.calendar_entries where id=target_entry and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  if scope not in ('series','future') or scope is null or expected_entry is null then raise exception 'Invalid series edit.';end if;
  select rrule into old_rule from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
  expected:=jsonb_populate_record(original,expected_entry);
  foreach field in array array['title','task_id','starts_at','ends_at','notification_offsets','is_pinned'] loop
    if to_jsonb(original)->field is distinct from to_jsonb(expected)->field then raise exception 'This calendar item changed. Reopen it before saving.';end if;
  end loop;
  if old_rule is distinct from expected_rule then raise exception 'This repeat rule changed. Reopen the item before saving.';end if;
  -- Only supported shared fields may change. Internal materialization is server-owned.
  patched:=jsonb_populate_record(original,jsonb_build_object('title',input->'title','task_id',input->'task_id','starts_at',input->'starts_at','ends_at',input->'ends_at','notification_offsets',coalesce(input->'notification_offsets',to_jsonb(original.notification_offsets)),'is_pinned',coalesce(input->'is_pinned',to_jsonb(original.is_pinned))));
  if patched.title is null or length(btrim(patched.title)) not between 1 and 240 or patched.starts_at is null or patched.ends_at is null or patched.ends_at<=patched.starts_at or patched.starts_at<'2000-01-01' or patched.ends_at>='2201-01-01' then raise exception 'Enter a title and valid time range (2000–2200).';end if;
  if patched.item_type='checklist' and not exists(select 1 from public.tasks where id=patched.task_id and user_id=auth.uid() and archived_at is null and deleted_at is null) then raise exception 'Choose an active Task for this checklist.';end if;
  if patched.item_type='reminder' and (patched.task_id is not null or patched.ends_at<>patched.starts_at+interval '15 minutes') then raise exception 'A Reminder uses one point in time.';end if;
  if scope='future' and (patched.notification_offsets is distinct from original.notification_offsets or patched.is_pinned is distinct from original.is_pinned) then raise exception 'Notifications and pin apply to the entire series.';end if;
  if scope='future' and patched.task_id is distinct from original.task_id then raise exception 'Task applies to the entire series. Change it using Edit entire series.';end if;
  if next_rule is not null and (length(next_rule)>4096 or next_rule!~'^FREQ=(DAILY|WEEKLY|MONTHLY)(;|$)' or next_rule!~'UNTIL=[0-9]{8}T[0-9]{6}Z') then raise exception 'Choose a valid repeat rule and end date.';end if;
  perform myplan_private.validate_selected_rule(next_rule,patched.starts_at,patched.ends_at,patched.item_type);
  if not original.occurrence_mode and cardinality(myplan_private.series_keys(original.starts_at,old_rule))>1000 then raise exception 'This series has more than 1,000 occurrences. Edit individual occurrences instead.';end if;
  keys:=myplan_private.effective_keys(target_entry,original.starts_at,old_rule,original.occurrence_mode);
  select array_agg(distinct value order by value) into keys from unnest(keys||coalesce((select array_agg(occurrence_start) from public.calendar_occurrence_states where calendar_entry_id=target_entry and owner_user_id=auth.uid()),'{}')) value;
  if cardinality(keys)>1000 then raise exception 'This series has more than 1,000 occurrences. Edit individual occurrences instead.';end if;
  if scope='future' and (from_start is null or not from_start=any(keys)) then raise exception 'This occurrence changed. Reopen it before editing the schedule.';end if;
  metadata_only:=original.occurrence_mode and next_rule is not distinct from old_rule and patched.starts_at=original.starts_at and patched.ends_at=original.ends_at;
  desired:=myplan_private.series_keys(patched.starts_at,next_rule);
  if cardinality(desired)>1000 or cardinality(desired)=0 then raise exception 'A repeat schedule can contain between 1 and 1,000 occurrences. Shorten its end date.';end if;
  foreach key in array keys loop
    select * into state from public.calendar_occurrence_states where calendar_entry_id=target_entry and owner_user_id=auth.uid() and occurrence_start=key;
    had_state:=found;
    shown_start:=coalesce(state.override_starts_at,key);shown_end:=coalesce(state.override_ends_at,key+(original.ends_at-original.starts_at));
    before_cut:=scope='future' and key<from_start;
    protected:=metadata_only or before_cut or coalesce(state.is_exception,false) or (case when had_state then state.completed_at else original.completed_at end) is not null or (case when had_state then state.not_needed_at else original.not_needed_at end) is not null or exists(select 1 from public.planner_annotations where occurrence_state_id=state.id and owner_user_id=auth.uid());
    row_value:=jsonb_build_object('id',state.id,'occurrence_start',key,'override_starts_at',shown_start,'override_ends_at',shown_end,'completed_at',case when had_state then state.completed_at else original.completed_at end,'not_needed_at',case when had_state then state.not_needed_at else original.not_needed_at end,'title_override',case when before_cut then coalesce(state.title_override,original.title) else case when patched.title is distinct from original.title and not coalesce(state.title_is_exception,false) then null else state.title_override end end,'title_is_exception',coalesce(state.title_is_exception,false),'is_exception',coalesce(state.is_exception,false));
    day_key:=to_char(key at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD');
    if protected then rows:=rows||jsonb_build_array(row_value);protected_days:=array_append(protected_days,day_key);
    else reusable:=jsonb_set(reusable,array[day_key],row_value);end if;
  end loop;
  duration:=patched.ends_at-patched.starts_at;
  if metadata_only then desired:='{}';end if;
  foreach key in array desired loop
    day_key:=to_char(key at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD');
    if scope='future' and day_key<to_char(from_start at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD') then continue;end if;
    if day_key=any(protected_days) then continue;end if;
    row_value:=coalesce(reusable->day_key,'{}')||jsonb_build_object('occurrence_start',coalesce((reusable->day_key)->'occurrence_start',to_jsonb(key)),'override_starts_at',key,'override_ends_at',key+duration,'is_exception',false);
    rows:=rows||jsonb_build_array(row_value);
  end loop;
  if jsonb_array_length(rows)>1000 then raise exception 'History plus the new schedule exceeds 1,000 occurrences. Shorten the new end date.';end if;
  select array_agg((value->>'occurrence_start')::timestamptz) into retained from jsonb_array_elements(rows);
  delete from public.calendar_occurrence_states where calendar_entry_id=target_entry and owner_user_id=auth.uid() and not occurrence_start=any(coalesce(retained,'{}'));
  for row_value in select value from jsonb_array_elements(rows) loop
    insert into public.calendar_occurrence_states(id,owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at,title_override,is_exception,title_is_exception)
    values(coalesce((row_value->>'id')::uuid,gen_random_uuid()),auth.uid(),target_entry,(row_value->>'occurrence_start')::timestamptz,(row_value->>'completed_at')::timestamptz,(row_value->>'not_needed_at')::timestamptz,(row_value->>'override_starts_at')::timestamptz,(row_value->>'override_ends_at')::timestamptz,row_value->>'title_override',coalesce((row_value->>'is_exception')::boolean,false),coalesce((row_value->>'title_is_exception')::boolean,false))
    on conflict(owner_user_id,calendar_entry_id,occurrence_start) do update set completed_at=excluded.completed_at,not_needed_at=excluded.not_needed_at,override_starts_at=excluded.override_starts_at,override_ends_at=excluded.override_ends_at,title_override=excluded.title_override,is_exception=excluded.is_exception,title_is_exception=excluded.title_is_exception;
  end loop;
  update public.calendar_entries set title=patched.title,task_id=patched.task_id,starts_at=patched.starts_at,ends_at=patched.ends_at,notification_offsets=patched.notification_offsets,is_pinned=patched.is_pinned,completed_at=null,not_needed_at=null,occurrence_mode=true where id=target_entry and owner_user_id=auth.uid();
  delete from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
  if next_rule is not null then insert into public.recurrence_rules(owner_user_id,calendar_entry_id,rrule,timezone) values(auth.uid(),target_entry,next_rule,original.timezone);end if;
  perform myplan_private.sync_task_checklists(original.task_id,true);
  if patched.task_id is distinct from original.task_id then perform myplan_private.sync_task_checklists(patched.task_id,true);end if;
end $$;

create function public.myplan_save_occurrence_annotation(target_entry uuid,original_start timestamptz,input jsonb,annotation_id uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare entry public.calendar_entries; state_id uuid; rule text;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into entry from public.calendar_entries where id=target_entry and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  select rrule into rule from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
  if not myplan_private.is_occurrence(target_entry,entry.starts_at,rule,entry.occurrence_mode,original_start) then raise exception 'Occurrence no longer exists.';end if;
  insert into public.calendar_occurrence_states(owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at) values(auth.uid(),target_entry,original_start,entry.completed_at,entry.not_needed_at) on conflict(owner_user_id,calendar_entry_id,occurrence_start) do nothing;
  select id into state_id from public.calendar_occurrence_states where owner_user_id=auth.uid() and calendar_entry_id=target_entry and occurrence_start=original_start;
  if annotation_id is null then insert into public.planner_annotations(owner_user_id,calendar_entry_id,occurrence_state_id,kind,body,url) values(auth.uid(),target_entry,state_id,input->>'kind',btrim(input->>'body'),case when input->>'kind'='link' then input->>'url' else null end);
  else
    update public.planner_annotations set kind=input->>'kind',body=btrim(input->>'body'),url=case when input->>'kind'='link' then input->>'url' else null end where id=annotation_id and owner_user_id=auth.uid() and calendar_entry_id=target_entry and occurrence_state_id=state_id;
    if not found then raise exception 'Comment no longer exists in this scope.';end if;
  end if;
end $$;
create or replace function myplan_private.sync_task_checklists(target_task uuid,force_empty boolean default false) returns void
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare task_row public.tasks; total integer; resolved integer; done boolean;
begin
  select * into task_row from public.tasks where id=target_task and user_id=auth.uid() for update;
  if not found then return; end if;
  with specs as (
    select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,myplan_private.effective_keys(e.id,e.starts_at,r.rrule,e.occurrence_mode) as effective_keys,
      coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
      case when e.occurrence_mode then 'materialized' when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly' when r.rrule like '%FREQ=WEEKLY%' then 'weekly' when r.rrule is not null then 'daily' else 'none' end as frequency,
      case when r.rrule is not null then to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],'YYYYMMDD"T"HH24MISS"Z"') end as until_at
    from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
    where e.task_id=target_task and e.owner_user_id=auth.uid() and e.item_type='checklist' and e.status<>'cancelled'
  ), occurrences as (
    select s.*,key as occurrence_start from specs s cross join lateral unnest(s.effective_keys) key
  ), outcomes as (
    select case when o.frequency='none' or state.calendar_entry_id is null then o.completed_at else state.completed_at end as completed_at,
      case when o.frequency='none' or state.calendar_entry_id is null then o.not_needed_at else state.not_needed_at end as not_needed_at
    from occurrences o left join public.calendar_occurrence_states state on state.calendar_entry_id=o.id and state.owner_user_id=auth.uid() and state.occurrence_start=o.occurrence_start
    where o.frequency in ('none','materialized') or o.occurrence_start<=o.until_at
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
      select e.id,e.owner_user_id,e.starts_at,r.rrule,myplan_private.effective_keys(e.id,e.starts_at,r.rrule,e.occurrence_mode) as effective_keys,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when e.occurrence_mode then 'materialized' when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly' else 'daily' end as frequency,
        to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
          'YYYYMMDD"T"HH24MISS"Z"') as until_at
      from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist' and (r.rrule is not null or e.occurrence_mode)
    ), occurrences as (
    select s.*,key as occurrence_start from specs s cross join lateral unnest(s.effective_keys) key
  )
    insert into public.calendar_occurrence_states
      (owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,updated_at)
    select owner_user_id,id,occurrence_start,null,changed_at,changed_at
    from occurrences where frequency='materialized' or occurrence_start<=until_at
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
      select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,myplan_private.effective_keys(e.id,e.starts_at,r.rrule,e.occurrence_mode) as effective_keys,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when e.occurrence_mode then 'materialized' when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly'
          when r.rrule is not null then 'daily' else 'none' end as frequency,
        case when r.rrule is not null then
          to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
            'YYYYMMDD"T"HH24MISS"Z"') end as until_at
      from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
    select s.*,key as occurrence_start from specs s cross join lateral unnest(s.effective_keys) key
  ), outcomes as (
      select coalesce(state.completed_at,o.completed_at) as completed_at,
        coalesce(state.not_needed_at,o.not_needed_at) as not_needed_at
      from occurrences o left join public.calendar_occurrence_states state
        on state.calendar_entry_id=o.id and state.occurrence_start=o.occurrence_start
      where o.frequency in ('none','materialized') or o.occurrence_start<=o.until_at
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
    case when e.occurrence_mode then 'materialized' when r.rrule like '%X-MYPLAN-DATES=%' then 'dates' when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
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
  from starts s cross join lateral generate_series(first_n,case when frequency='none' then first_n when frequency='dates' then cardinality(myplan_private.selected_date_offsets(s.rrule))-1 else first_n+5 end) n where frequency<>'materialized'
  union
  -- Include moved occurrences even when their original date lies outside the
  -- generated horizon. Rechecking before send also cancels stale queued jobs.
  select s.id,st.occurrence_start from rules s join public.calendar_occurrence_states st
    on st.calendar_entry_id=s.id and (s.frequency='materialized' or st.override_starts_at is not null)
    and (s.frequency<>'dates' or st.occurrence_start in (select s.starts_at+make_interval(days=>d) from unnest(myplan_private.selected_date_offsets(s.rrule)) d))
), effective as (
  select r.*,g.original_start,coalesce(st.override_starts_at,g.original_start) as shown_start,
    st.completed_at as occurrence_completed_at,st.not_needed_at as occurrence_not_needed_at,coalesce(st.title_override,r.title) as effective_title
  from generated g join rules r on r.id=g.id left join public.calendar_occurrence_states st
    on st.calendar_entry_id=g.id and st.occurrence_start=g.original_start
  where r.frequency='materialized' or r.until_at is null or g.original_start<=r.until_at
)
select md5(ps.id::text||':'||e.id::text||':'||extract(epoch from e.original_start)::text||':'||o::text),
  ps.id,ps.owner_user_id,ps.endpoint,ps.p256dh,ps.auth,e.id,e.original_start,o,e.item_type,e.effective_title,
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
returns table(subscription_id uuid,owner_user_id uuid,endpoint text,p256dh text,auth text,calendar_entry_id uuid,occurrence_start timestamptz,offset_minutes integer,item_type text,item_title text)
language sql security definer set search_path='' set timezone='UTC' as $$
 select j.subscription_id,j.owner_user_id,j.endpoint,j.p256dh,j.auth,j.calendar_entry_id,j.occurrence_start,j.offset_minutes,j.item_type,j.item_title
 from (select distinct owner_user_id from public.push_subscriptions where disabled_at is null) owners
 cross join lateral myplan_private.push_candidates(owners.owner_user_id,check_at) j
 where j.due_at<=check_at and j.due_at>check_at-interval '3 minutes' limit 500;
$$;

create or replace function public.myplan_update_occurrence(target_entry uuid,original_start timestamptz,changes jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare entry public.calendar_entries; patched public.calendar_occurrence_states; field text; rule text;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into entry from public.calendar_entries where id=target_entry and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  if original_start is null or original_start<'2000-01-01' or original_start>='2201-01-01' then raise exception 'Invalid occurrence date.';end if;
  select rrule into rule from public.recurrence_rules where calendar_entry_id=target_entry and owner_user_id=auth.uid();
  if not myplan_private.is_occurrence(target_entry,entry.starts_at,rule,entry.occurrence_mode,original_start) then raise exception 'Occurrence no longer exists.';end if;
  for field in select jsonb_object_keys(changes) loop
    if field not in ('completed_at','not_needed_at','override_starts_at','override_ends_at','title_override') then raise exception 'Unsupported occurrence field: %',field;end if;
  end loop;
  select * into patched from public.calendar_occurrence_states where calendar_entry_id=target_entry and occurrence_start=original_start and owner_user_id=auth.uid() for update;
  patched:=jsonb_populate_record(patched,changes);
  if patched.completed_at is not null and patched.not_needed_at is not null then raise exception 'Choose Done or Not needed, not both.';end if;
  if (patched.override_starts_at is null)<>(patched.override_ends_at is null) or patched.override_ends_at<=patched.override_starts_at or patched.override_starts_at<'2000-01-01' or patched.override_ends_at>='2201-01-01' then raise exception 'Invalid occurrence time range.';end if;
  insert into public.calendar_occurrence_states(owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at,title_override,is_exception,title_is_exception)
  values(auth.uid(),target_entry,original_start,patched.completed_at,patched.not_needed_at,patched.override_starts_at,patched.override_ends_at,patched.title_override,true,case when changes?'title_override' then true else coalesce(patched.title_is_exception,false) end)
  on conflict(owner_user_id,calendar_entry_id,occurrence_start) do update set completed_at=excluded.completed_at,not_needed_at=excluded.not_needed_at,override_starts_at=excluded.override_starts_at,override_ends_at=excluded.override_ends_at,title_override=excluded.title_override,is_exception=true,title_is_exception=excluded.title_is_exception;
  perform myplan_private.sync_task_checklists(entry.task_id,true);
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
  if rule_text like 'FREQ=MONTHLY%' and not entry_row.occurrence_mode then
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
create function public.myplan_move_occurrences(target_entry uuid,changes jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare row_value jsonb;
begin
  if jsonb_typeof(changes)<>'array' or jsonb_array_length(changes)>1000 then raise exception 'Invalid occurrence moves.';end if;
  for row_value in select value from jsonb_array_elements(changes) loop
    perform public.myplan_update_occurrence(target_entry,(row_value->>'occurrence_start')::timestamptz,row_value-'occurrence_start');
  end loop;
end $$;
revoke all on function public.myplan_revise_calendar_series(uuid,jsonb,text,text,timestamptz,jsonb,text),public.myplan_save_occurrence_annotation(uuid,timestamptz,jsonb,uuid),public.myplan_move_occurrences(uuid,jsonb) from public,anon;
grant execute on function public.myplan_revise_calendar_series(uuid,jsonb,text,text,timestamptz,jsonb,text),public.myplan_save_occurrence_annotation(uuid,timestamptz,jsonb,uuid),public.myplan_move_occurrences(uuid,jsonb) to authenticated;
revoke all on function myplan_private.series_keys(timestamptz,text),myplan_private.effective_keys(uuid,timestamptz,text,boolean),myplan_private.is_occurrence(uuid,timestamptz,text,boolean,timestamptz) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
