-- Per-browser-session receipts, written only by planning mutations carrying an
-- operation header. No public access to history; Undo verifies all changed
-- fields under row locks before restoring anything.
begin;
create table myplan_private.undo_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null, operation_id uuid not null,
  table_name text not null, row_key jsonb not null,
  before_row jsonb, after_row jsonb,
  sequence bigint generated always as identity,
  created_at timestamptz not null default now(),
  primary key(owner_id,session_id,operation_id,table_name,row_key)
);
create index undo_receipts_retention on myplan_private.undo_receipts(owner_id,session_id,created_at);
revoke all on myplan_private.undo_receipts from public,anon,authenticated;

create function myplan_private.bound_undo(owner_value uuid,session_value uuid,op_value uuid) returns void
language plpgsql security definer set search_path='' as $$
declare victim record;
begin
  if exists(select 1 from myplan_private.undo_receipts where owner_id=owner_value and session_id=session_value and operation_id=op_value having count(*)>2000 or coalesce(sum(coalesce(pg_column_size(before_row),0)+coalesce(pg_column_size(after_row),0)),0)>1048576) then
    delete from myplan_private.undo_receipts where owner_id=owner_value and session_id=session_value and operation_id=op_value;
    -- A marker disables the ENTIRE oversized operation, including later rows.
    insert into myplan_private.undo_receipts(owner_id,session_id,operation_id,table_name,row_key) values(owner_value,session_value,op_value,'!unavailable','{}');
  end if;
  while (select coalesce(sum(coalesce(pg_column_size(before_row),0)+coalesce(pg_column_size(after_row),0)),0)>2097152 from myplan_private.undo_receipts where owner_id=owner_value) loop
    select session_id,operation_id into victim from myplan_private.undo_receipts where owner_id=owner_value and (session_id,operation_id)<>(session_value,op_value) group by session_id,operation_id order by min(sequence) limit 1;
    if not found then exit; end if;
    delete from myplan_private.undo_receipts where owner_id=owner_value and session_id=victim.session_id and operation_id=victim.operation_id;
  end loop;
end $$;
revoke all on function myplan_private.bound_undo(uuid,uuid,uuid) from public,anon,authenticated;

create function myplan_private.lock_planning_write() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is not null then perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));end if;
  return null;
end $$;
revoke all on function myplan_private.lock_planning_write() from public,anon,authenticated;

create function myplan_private.capture_undo() returns trigger language plpgsql security definer set search_path='' as $$
declare headers jsonb; op uuid; session uuid; before_value jsonb; after_value jsonb; row_value jsonb; key_value jsonb; before_key jsonb; owner_value uuid;
begin
  if current_setting('myplan.undo_replaying',true)='true' or auth.uid() is null then return null; end if;
  begin
    headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
    op:=(headers->>'x-myplan-undo-operation')::uuid;
    session:=(headers->>'x-myplan-undo-session')::uuid;
  exception when invalid_text_representation then return null; end;
  if op is null or session is null then return null; end if;
  if tg_op<>'INSERT' then before_value:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then after_value:=to_jsonb(new); end if;
  row_value:=coalesce(after_value,before_value);
  owner_value:=coalesce(row_value->>'user_id',row_value->>'owner_user_id')::uuid;
  if owner_value is distinct from auth.uid() then return null; end if;
  -- Bound history per account, not by a client-provided session ID. A new
  -- session must not bypass retention by choosing another UUID.
  delete from myplan_private.undo_receipts where owner_id=owner_value and (created_at<now()-interval '1 day' or (session_id,operation_id) in (
    select session_id,operation_id from myplan_private.undo_receipts where owner_id=owner_value and (session_id,operation_id)<>(session,op) group by session_id,operation_id order by max(sequence) desc offset 19
  ));
  if exists(select 1 from myplan_private.undo_receipts where owner_id=owner_value and session_id=session and operation_id=op and table_name='!unavailable') then return null; end if;
  key_value:=case when tg_table_name='calendar_occurrence_states' then jsonb_build_object('calendar_entry_id',row_value->'calendar_entry_id','occurrence_start',row_value->'occurrence_start') else jsonb_build_object('id',row_value->'id') end;
  if tg_op='UPDATE' and tg_table_name='calendar_occurrence_states' and before_value->'occurrence_start' is distinct from after_value->'occurrence_start' then
    before_key:=jsonb_build_object('calendar_entry_id',before_value->'calendar_entry_id','occurrence_start',before_value->'occurrence_start');
    update myplan_private.undo_receipts set row_key=key_value,after_row=after_value where owner_id=owner_value and session_id=session and operation_id=op and table_name=tg_table_name and row_key=before_key;
    if found then perform myplan_private.bound_undo(owner_value,session,op);return null; end if;
  end if;
  insert into myplan_private.undo_receipts(owner_id,session_id,operation_id,table_name,row_key,before_row,after_row)
  values(owner_value,session,op,tg_table_name,key_value,before_value,after_value)
  on conflict(owner_id,session_id,operation_id,table_name,row_key) do update set after_row=excluded.after_row;
  perform myplan_private.bound_undo(owner_value,session,op);
  return null;
end $$;
revoke all on function myplan_private.capture_undo() from public,anon,authenticated;
do $$ declare tab text; begin
  foreach tab in array array['goals','tasks','calendar_entries','recurrence_rules','calendar_occurrence_states','timeline_milestones'] loop
    execute format('create trigger aa_lock_planning_write before insert or update or delete on public.%I for each statement execute function myplan_private.lock_planning_write()',tab);
    execute format('create trigger zz_capture_undo after insert or update or delete on public.%I for each row execute function myplan_private.capture_undo()',tab);
  end loop;
end $$;

create function public.myplan_undo_ready(target_operation uuid,target_session uuid) returns boolean
language plpgsql security definer set search_path='' as $$ begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.'; end if;
  -- Keep at most 20 recent commands per browser session and expire old content.
  delete from myplan_private.undo_receipts where owner_id=auth.uid() and (created_at<now()-interval '1 day' or (session_id=target_session and operation_id not in (
    select operation_id from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session group by operation_id order by max(sequence) desc limit 20
  )));
  return exists(select 1 from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation and table_name<>'!unavailable');
end $$;

create function myplan_private.sync_task_checklists(target_task uuid,force_empty boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare task_row public.tasks; total integer; resolved integer; done boolean;
begin
  select * into task_row from public.tasks where id=target_task and user_id=auth.uid() for update;
  if not found then return; end if;
  with specs as (
    select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,
      coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
      case when r.rrule like '%FREQ=MONTHLY%' then 'monthly' when r.rrule like '%FREQ=WEEKLY%' then 'weekly' when r.rrule is not null then 'daily' else 'none' end as frequency,
      case when r.rrule is not null then to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],'YYYYMMDD"T"HH24MISS"Z"') end as until_at
    from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
    where e.task_id=target_task and e.owner_user_id=auth.uid() and e.item_type='checklist' and e.status<>'cancelled'
  ), occurrences as (
    select s.*,case s.frequency when 'daily' then s.starts_at+make_interval(days=>n*s.step) when 'weekly' then s.starts_at+make_interval(days=>n*s.step*7) when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step) else s.starts_at end as occurrence_start
    from specs s cross join lateral generate_series(0,case when s.frequency='none' then 0 else 999 end) n
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
revoke all on function myplan_private.sync_task_checklists(uuid,boolean) from public,anon,authenticated;

create function public.myplan_undo_apply(target_operation uuid,target_session uuid) returns void
language plpgsql security definer set search_path='' as $$
declare receipt record; current_value jsonb; key_name text; columns_sql text; owner_col text; changed_fields text[]; temporary timestamptz; task_id_value uuid; affected_checklists uuid[];
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  if not exists(select 1 from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation and table_name<>'!unavailable' and created_at>=now()-interval '1 day') then raise exception 'Undo is no longer available.'; end if;
  -- Lock and compare EVERY affected record before restoring any one record.
  for receipt in select * from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation order by table_name,row_key::text for update loop
    if receipt.table_name not in ('goals','tasks','calendar_entries','recurrence_rules','calendar_occurrence_states','timeline_milestones') then raise exception 'Invalid Undo target.'; end if;
    owner_col:=case when receipt.table_name in ('goals','tasks') then 'user_id' else 'owner_user_id' end;
    execute format('select to_jsonb(t) from public.%I t where to_jsonb(t) @> $1 and %I=$2 for update',receipt.table_name,owner_col) into current_value using receipt.row_key,auth.uid();
    if receipt.after_row is null then
      if current_value is not null then raise exception 'Undo conflict: this record was recreated.'; end if;
    elsif current_value is null then raise exception 'Undo conflict: this record was removed.';
    else
      for key_name in select jsonb_object_keys(receipt.after_row) loop
        if key_name in ('updated_at','created_at') then continue; end if;
        if receipt.before_row is null or (receipt.before_row->key_name) is distinct from (receipt.after_row->key_name) then
          if (current_value->key_name) is distinct from (receipt.after_row->key_name) then raise exception 'Undo conflict: this item has changed since your action.'; end if;
        end if;
      end loop;
    end if;
  end loop;
  perform set_config('myplan.undo_replaying','true',true);
  select array_agg(distinct value) into affected_checklists from (
    select (before_row->>'task_id')::uuid as value from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation and table_name='calendar_entries'
    union select (after_row->>'task_id')::uuid from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation and table_name='calendar_entries'
    union select e.task_id from public.calendar_entries e join myplan_private.undo_receipts r on (r.row_key->>'calendar_entry_id')::uuid=e.id where r.owner_id=auth.uid() and r.session_id=target_session and r.operation_id=target_operation and r.table_name='calendar_occurrence_states'
  ) ids where value is not null;
  for receipt in select * from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation and table_name='calendar_occurrence_states' and before_row is not null and after_row is not null and before_row->'occurrence_start' is distinct from after_row->'occurrence_start' loop
    temporary:=(receipt.after_row->>'occurrence_start')::timestamptz+interval '2000 years';
    update public.calendar_occurrence_states t set occurrence_start=temporary where to_jsonb(t) @> receipt.row_key and owner_user_id=auth.uid();
    update myplan_private.undo_receipts set row_key=jsonb_set(row_key,'{occurrence_start}',to_jsonb(temporary)) where sequence=receipt.sequence;
  end loop;
  for receipt in select * from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation order by sequence desc loop
    owner_col:=case when receipt.table_name in ('goals','tasks') then 'user_id' else 'owner_user_id' end;
    if receipt.before_row is null then
      if receipt.after_row is null then continue; end if;
      -- New top-level entities are not recorded by the client. Inserts made
      -- while editing are leaf recurrence rules/states, safe to remove.
      if receipt.table_name not in ('recurrence_rules','calendar_occurrence_states') then raise exception 'Undo creation is not supported for this action.'; end if;
      execute format('delete from public.%I t where to_jsonb(t) @> $1 and %I=$2',receipt.table_name,owner_col) using receipt.row_key,auth.uid();
    elsif receipt.after_row is null then
      if receipt.table_name not in ('recurrence_rules','calendar_occurrence_states') then raise exception 'Permanent deletion cannot be undone.'; end if;
      execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I,$1)',receipt.table_name,receipt.table_name) using receipt.before_row;
    else
      select array_agg(key) into changed_fields from jsonb_object_keys(receipt.before_row) as key
      where key not in ('id','user_id','owner_user_id','created_at','updated_at') and (receipt.before_row->key) is distinct from (receipt.after_row->key);
      if coalesce(array_length(changed_fields,1),0)=0 then continue; end if;
      select string_agg(format('%I',name),',') into columns_sql from unnest(changed_fields) as name;
      execute format('update public.%I t set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where to_jsonb(t) @> $2 and %I=$3',receipt.table_name,columns_sql,columns_sql,receipt.table_name,owner_col) using receipt.before_row,receipt.row_key,auth.uid();
    end if;
  end loop;
  for task_id_value in select (row_key->>'id')::uuid from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation and table_name='tasks' loop
    perform myplan_private.sync_task_checklists(task_id_value);
  end loop;
  foreach task_id_value in array coalesce(affected_checklists,'{}') loop perform myplan_private.sync_task_checklists(task_id_value,true);end loop;
  delete from myplan_private.undo_receipts where owner_id=auth.uid() and session_id=target_session and operation_id=target_operation;
end $$;
revoke all on function public.myplan_undo_ready(uuid,uuid),public.myplan_undo_apply(uuid,uuid) from public,anon;
grant execute on function public.myplan_undo_ready(uuid,uuid),public.myplan_undo_apply(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
create function public.myplan_save_task_edit(target_task uuid,changes jsonb,should_complete boolean) returns void
language plpgsql security definer set search_path='' as $$
declare original public.tasks; patched public.tasks; key_name text;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into original from public.tasks where id=target_task and user_id=auth.uid() for update;
  if not found then raise exception 'Task not found.'; end if;
  for key_name in select jsonb_object_keys(changes) loop
    if key_name not in ('title','priority','goal_id','planned_start','planned_end','due_at','parent_task_id','dependency_task_id','status','link_url','link_label','is_milestone') then raise exception 'Unsupported Task property: %',key_name; end if;
  end loop;
  patched:=jsonb_populate_record(original,changes);
  if not should_complete and patched.status='completed' then raise exception 'Task status and completion must agree.'; end if;
  if length(btrim(patched.title)) not between 1 and 240 then raise exception 'Enter a title (maximum 240 characters).'; end if;
  if patched.planned_start is not null and (patched.planned_start<'2000-01-01' or patched.planned_start>'2200-12-31') then raise exception 'Task start must use a year between 2000 and 2200.'; end if;
  if patched.due_at is not null and (patched.due_at<'2000-01-01' or patched.due_at>'2201-01-01') then raise exception 'Task deadline must use a year between 2000 and 2200.'; end if;
  if patched.planned_start is not null and patched.due_at is not null and (patched.due_at at time zone 'Asia/Ho_Chi_Minh')::date<patched.planned_start then raise exception 'Deadline cannot be before start.'; end if;
  if patched.link_url is not null and patched.link_url!~* '^https?://[^[:space:]]+$' then raise exception 'Use an HTTP or HTTPS link.'; end if;
  if original.completed_at is not null and not should_complete then perform public.set_myplan_task_completion(target_task,false); end if;
  if not should_complete and exists(select 1 from public.tasks where id=target_task and user_id=auth.uid() and completed_at is not null) then
    raise exception 'This Task is complete because its checklists are complete. Reopen a checklist first.';
  end if;
  update public.tasks set title=patched.title,priority=patched.priority,goal_id=patched.goal_id,planned_start=patched.planned_start,planned_end=patched.planned_end,due_at=patched.due_at,
    parent_task_id=patched.parent_task_id,dependency_task_id=patched.dependency_task_id,link_url=patched.link_url,link_label=patched.link_label,is_milestone=patched.is_milestone,
    status=case when should_complete then original.status else patched.status end
    where id=target_task and user_id=auth.uid();
  if original.completed_at is null and should_complete then perform public.set_myplan_task_completion(target_task,true); end if;
end $$;
revoke all on function public.myplan_save_task_edit(uuid,jsonb,boolean) from public,anon;
grant execute on function public.myplan_save_task_edit(uuid,jsonb,boolean) to authenticated;
commit;
