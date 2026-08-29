-- Atomic edits and Timeline commands. Keep metadata, recurrence and derived
-- state in a single transaction so failed saves/Undo cannot leave half a change.
begin;
-- Legacy RPCs lock rows with SELECT FOR UPDATE. Enter the same account lock
-- BEFORE that read, matching Undo and direct-table BEFORE STATEMENT writes.
alter function public.set_myplan_task_completion(uuid,boolean) set schema myplan_private;
alter function public.move_calendar_series(uuid,timestamptz,timestamptz,timestamptz,timestamptz) set schema myplan_private;
alter function public.delete_myplan_goal(uuid) set schema myplan_private;
alter function public.delete_myplan_task(uuid) set schema myplan_private;
revoke all on function myplan_private.set_myplan_task_completion(uuid,boolean),myplan_private.move_calendar_series(uuid,timestamptz,timestamptz,timestamptz,timestamptz),myplan_private.delete_myplan_goal(uuid),myplan_private.delete_myplan_task(uuid) from public,anon,authenticated;
create function public.set_myplan_task_completion(target_task_id uuid,should_complete boolean) returns void language plpgsql security definer set search_path='' as $$ begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  perform myplan_private.set_myplan_task_completion(target_task_id,should_complete);
end $$;
create function public.move_calendar_series(target_entry_id uuid,original_occurrence_start timestamptz,original_occurrence_end timestamptz,next_occurrence_start timestamptz,next_occurrence_end timestamptz) returns void language plpgsql security definer set search_path='' as $$
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
  perform myplan_private.sync_task_checklists(entry_row.task_id,true);
end $$;
create function public.delete_myplan_goal(target_goal_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  perform myplan_private.delete_myplan_goal(target_goal_id);
end $$;
create function public.delete_myplan_task(target_task_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  perform myplan_private.delete_myplan_task(target_task_id);
end $$;
revoke all on function public.set_myplan_task_completion(uuid,boolean),public.move_calendar_series(uuid,timestamptz,timestamptz,timestamptz,timestamptz),public.delete_myplan_goal(uuid),public.delete_myplan_task(uuid) from public,anon;
grant execute on function public.set_myplan_task_completion(uuid,boolean),public.move_calendar_series(uuid,timestamptz,timestamptz,timestamptz,timestamptz),public.delete_myplan_goal(uuid),public.delete_myplan_task(uuid) to authenticated;

create function public.myplan_update_calendar_entry(target_entry uuid,changes jsonb,next_rule text,rule_changed boolean default false,expected_rule text default null,expected_entry jsonb default null) returns void
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
  if next_rule is not null and (length(next_rule)>1024 or next_rule!~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;|$)') then raise exception 'Invalid recurrence rule.';end if;
  if patched.item_type='checklist' and next_rule is not null and next_rule!~ 'UNTIL=[0-9]{8}T[0-9]{6}Z' then raise exception 'Repeating checklist requires an end date.';end if;
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

create function public.myplan_update_occurrence(target_entry uuid,original_start timestamptz,changes jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare entry public.calendar_entries; patched public.calendar_occurrence_states; field text;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into entry from public.calendar_entries where id=target_entry and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  if original_start is null or original_start<'2000-01-01' or original_start>='2201-01-01' then raise exception 'Invalid occurrence date.';end if;
  for field in select jsonb_object_keys(changes) loop
    if field not in ('completed_at','not_needed_at','override_starts_at','override_ends_at') then raise exception 'Unsupported occurrence field: %',field;end if;
  end loop;
  select * into patched from public.calendar_occurrence_states where calendar_entry_id=target_entry and occurrence_start=original_start and owner_user_id=auth.uid() for update;
  patched:=jsonb_populate_record(patched,changes);
  if patched.completed_at is not null and patched.not_needed_at is not null then raise exception 'Choose Done or Not needed, not both.';end if;
  if (patched.override_starts_at is null)<>(patched.override_ends_at is null) or patched.override_ends_at<=patched.override_starts_at or patched.override_starts_at<'2000-01-01' or patched.override_ends_at>='2201-01-01' then raise exception 'Invalid occurrence time range.';end if;
  insert into public.calendar_occurrence_states(owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at)
  values(auth.uid(),target_entry,original_start,patched.completed_at,patched.not_needed_at,patched.override_starts_at,patched.override_ends_at)
  on conflict(owner_user_id,calendar_entry_id,occurrence_start) do update set completed_at=excluded.completed_at,not_needed_at=excluded.not_needed_at,override_starts_at=excluded.override_starts_at,override_ends_at=excluded.override_ends_at;
  perform myplan_private.sync_task_checklists(entry.task_id,true);
end $$;
revoke all on function public.myplan_update_calendar_entry(uuid,jsonb,text,boolean,text,jsonb),public.myplan_update_occurrence(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.myplan_update_calendar_entry(uuid,jsonb,text,boolean,text,jsonb),public.myplan_update_occurrence(uuid,timestamptz,jsonb) to authenticated;
create function myplan_private.timeline_group_snapshot(target_goal uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare goal_row jsonb; task_ids uuid[]; entry_ids uuid[];
begin
  select to_jsonb(g) into goal_row from public.goals g where id=target_goal and user_id=auth.uid() and status<>'archived' and deleted_at is null;
  if goal_row is null then raise exception 'Goal not found.';end if;
  select coalesce(array_agg(id),'{}') into task_ids from public.tasks where goal_id=target_goal and user_id=auth.uid() and archived_at is null and deleted_at is null;
  select coalesce(array_agg(id),'{}') into entry_ids from public.calendar_entries where task_id=any(task_ids) and owner_user_id=auth.uid();
  return jsonb_build_object('goal',goal_row,
    'tasks',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.tasks t where id=any(task_ids) and user_id=auth.uid()),
    'milestones',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.timeline_milestones m where (goal_id=target_goal or task_id=any(task_ids)) and owner_user_id=auth.uid()),
    'entries',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.calendar_entries e where id=any(entry_ids) and owner_user_id=auth.uid()),
    'rules',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.recurrence_rules r where calendar_entry_id=any(entry_ids) and owner_user_id=auth.uid()),
    'states',(select coalesce(jsonb_agg(to_jsonb(s) order by calendar_entry_id,occurrence_start),'[]') from public.calendar_occurrence_states s where calendar_entry_id=any(entry_ids) and owner_user_id=auth.uid()));
end $$;
revoke all on function myplan_private.timeline_group_snapshot(uuid) from public,anon,authenticated;
create function public.myplan_preview_timeline_group(target_goal uuid) returns jsonb language plpgsql security definer set search_path='' as $$ declare snapshot jsonb;begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  snapshot:=myplan_private.timeline_group_snapshot(target_goal);
  return jsonb_build_object('version',md5(snapshot::text),'tasks',jsonb_array_length(snapshot->'tasks'),'milestones',jsonb_array_length(snapshot->'milestones'),'calendar',jsonb_array_length(snapshot->'entries'));
end $$;
create function public.myplan_move_timeline_group(target_goal uuid,day_offset integer,expected_version text) returns void language plpgsql security definer set search_path='' as $$
declare snapshot jsonb; row_value jsonb; field text; next_value timestamptz;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  if day_offset is null or abs(day_offset::bigint)>73000 then raise exception 'Invalid day offset.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  snapshot:=myplan_private.timeline_group_snapshot(target_goal);
  if md5(snapshot::text) is distinct from expected_version then raise exception 'This group changed. Review the affected items again before moving it.';end if;
  -- Bounds cover all moved fields, including overrides and repeat horizons.
  for row_value in select value from jsonb_array_elements(jsonb_build_array(snapshot->'goal')||(snapshot->'tasks')||(snapshot->'milestones')||(snapshot->'entries')||(snapshot->'states')) loop
    foreach field in array array['starts_at','ends_at','planned_start','planned_end','due_at','milestone_on','occurrence_start','override_starts_at','override_ends_at'] loop
      if row_value->>field is not null then next_value:=(row_value->>field)::timestamptz+make_interval(days=>day_offset);if next_value<'2000-01-01' or next_value>='2201-01-01' then raise exception 'Moved dates must stay between 2000 and 2200.';end if;end if;
    end loop;
  end loop;
  for row_value in select value from jsonb_array_elements(snapshot->'rules') loop
    if row_value->>'rrule' like '%UNTIL=%' then next_value:=to_date(substring(row_value->>'rrule' from 'UNTIL=([0-9]{8})'),'YYYYMMDD')+day_offset;if next_value<'2000-01-01' or next_value>='2201-01-01' then raise exception 'Moved repeat horizon must stay between 2000 and 2200.';end if;end if;
  end loop;
  update public.goals set starts_at=starts_at+make_interval(days=>day_offset),ends_at=ends_at+make_interval(days=>day_offset) where id=target_goal and user_id=auth.uid();
  for row_value in select value from jsonb_array_elements(snapshot->'tasks') loop
    update public.tasks set planned_start=planned_start+day_offset,planned_end=planned_end+day_offset,due_at=due_at+make_interval(days=>day_offset) where id=(row_value->>'id')::uuid and user_id=auth.uid();
  end loop;
  for row_value in select value from jsonb_array_elements(snapshot->'milestones') loop
    update public.timeline_milestones set milestone_on=milestone_on+day_offset where id=(row_value->>'id')::uuid and owner_user_id=auth.uid();
  end loop;
  for row_value in select value from jsonb_array_elements(snapshot->'entries') loop
    perform public.move_calendar_series((row_value->>'id')::uuid,(row_value->>'starts_at')::timestamptz,(row_value->>'ends_at')::timestamptz,(row_value->>'starts_at')::timestamptz+make_interval(days=>day_offset),(row_value->>'ends_at')::timestamptz+make_interval(days=>day_offset));
  end loop;
end $$;
create function public.myplan_move_timeline_task(target_task uuid,input jsonb) returns void language plpgsql security definer set search_path='' as $$
declare task_row public.tasks; next_goal uuid; day_offset integer;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into task_row from public.tasks where id=target_task and user_id=auth.uid() and archived_at is null and deleted_at is null for update;
  if not found then raise exception 'Task not found.';end if;
  next_goal:=(input->>'goal_id')::uuid;day_offset:=(input->>'days')::integer;
  if day_offset is null or abs(day_offset::bigint)>73000 then raise exception 'Invalid day offset.';end if;
  if task_row.goal_id is distinct from (input->>'expected_goal')::uuid or task_row.parent_task_id is distinct from (input->>'expected_parent')::uuid or task_row.planned_start is distinct from (input->>'expected_start')::date or task_row.due_at is distinct from (input->>'expected_due')::timestamptz then raise exception 'This task changed. Reload its schedule before moving it.';end if;
  if next_goal is not null and not exists(select 1 from public.goals where id=next_goal and user_id=auth.uid() and status<>'archived' and deleted_at is null) then raise exception 'Target Goal is not active.';end if;
  if (task_row.planned_start+day_offset)<'2000-01-01' or (task_row.planned_start+day_offset)>'2200-12-31' or (task_row.planned_end+day_offset)<'2000-01-01' or (task_row.planned_end+day_offset)>'2200-12-31' or task_row.due_at+make_interval(days=>day_offset)<'2000-01-01' or task_row.due_at+make_interval(days=>day_offset)>='2201-01-01' then raise exception 'Moved dates must stay between 2000 and 2200.';end if;
  if next_goal is distinct from task_row.goal_id then
    -- Only this task changes Goal. Its children stay in the original Goal.
    update public.tasks set parent_task_id=task_row.parent_task_id where parent_task_id=target_task and user_id=auth.uid();
  end if;
  update public.tasks set goal_id=next_goal,parent_task_id=case when next_goal is distinct from task_row.goal_id then null else task_row.parent_task_id end,
    planned_start=planned_start+day_offset,planned_end=planned_end+day_offset,due_at=due_at+make_interval(days=>day_offset) where id=target_task and user_id=auth.uid();
end $$;
revoke all on function public.myplan_preview_timeline_group(uuid),public.myplan_move_timeline_group(uuid,integer,text),public.myplan_move_timeline_task(uuid,jsonb) from public,anon;
grant execute on function public.myplan_preview_timeline_group(uuid),public.myplan_move_timeline_group(uuid,integer,text),public.myplan_move_timeline_task(uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
