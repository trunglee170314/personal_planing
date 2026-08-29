-- Disposable network-isolated PostgreSQL only. Never apply to Supabase.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000099','dates@example.test',now()),
 ('00000000-0000-4000-8000-000000000098','other-dates@example.test',now());
update myplan_private.members set status='approved',record_limit=1000;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare task uuid; entry uuid; payload jsonb; rule text; n integer;
  op uuid:='00000000-0000-4000-8000-000000000032';
  sess uuid:='00000000-0000-4000-8000-000000000033';
begin
  insert into public.tasks(title) values('Selected dates Task') returning id into task;
  payload:=jsonb_build_object('title','Three selected dates','task_id',task,'item_type','checklist','timezone','Asia/Ho_Chi_Minh','starts_at','2026-10-16T01:00:00Z','ends_at','2026-10-16T02:00:00Z','notification_offsets',array[0]);
  rule:='FREQ=DAILY;INTERVAL=1;UNTIL=20261023T235959Z;X-MYPLAN-DATES=0,2,7';
  entry:=public.myplan_create_selected_checklist(payload,rule);
  begin
    perform public.move_calendar_series(entry,'2026-10-16T01:00:00Z','2026-10-16T02:00:00Z','2026-10-16T01:00:00Z','2026-10-16T18:00:00Z');
    raise exception 'Overnight selected-date series accepted';
  exception when raise_exception then if SQLERRM not like 'Selected-date Checklists%' then raise;end if;end;
  if (select count(*) from public.calendar_entries where task_id=task)<>1 then raise exception 'Duplicated entry';end if;
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
  perform public.myplan_update_occurrence(entry,'2026-10-18T01:00:00Z','{"completed_at":"2026-10-18T02:00:00Z"}');
  perform set_config('request.headers','{}',true);
  if (select progress from public.tasks where id=task)<>33 then raise exception 'Sparse progress is not 1/3';end if;
  perform public.myplan_undo_apply(op,sess);
  perform set_config('myplan.undo_replaying','false',true);
  if (select progress from public.tasks where id=task)<>0 then raise exception 'Occurrence Undo failed';end if;
  perform public.myplan_update_occurrence(entry,'2026-10-18T01:00:00Z','{"completed_at":"2026-10-18T02:00:00Z"}');
  perform public.set_myplan_task_completion(task,true);
  if (select count(*) from public.calendar_occurrence_states where calendar_entry_id=entry)<>3 then raise exception 'Manual completion generated unselected days';end if;
  perform public.set_myplan_task_completion(task,false);
  if (select progress from public.tasks where id=task)<>33 then raise exception 'Reopen did not preserve original Done';end if;
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
  perform public.move_calendar_series(entry,'2026-10-16T01:00:00Z','2026-10-16T02:00:00Z','2026-10-18T02:00:00Z','2026-10-18T03:00:00Z');
  perform set_config('request.headers','{}',true);
  if not exists(select 1 from public.recurrence_rules where calendar_entry_id=entry and rrule='FREQ=DAILY;INTERVAL=1;UNTIL=20261025T235959Z;X-MYPLAN-DATES=0,2,7') then raise exception 'Move changed sparse pattern';end if;
  if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry and occurrence_start='2026-10-20T02:00:00Z' and completed_at is not null) then raise exception 'Move lost Done identity';end if;
  perform public.myplan_undo_apply(op,sess);
  perform set_config('myplan.undo_replaying','false',true);
  if not exists(select 1 from public.recurrence_rules where calendar_entry_id=entry and rrule=rule) then raise exception 'Series Undo lost rule';end if;
  perform public.myplan_update_calendar_entry(entry,'{"title":"Shared title"}',rule,false,rule,null);
  if (select title from public.calendar_entries where id=entry)<>'Shared title' then raise exception 'Metadata edit failed';end if;
  begin
    perform public.myplan_update_calendar_entry(entry,'{}','FREQ=DAILY;INTERVAL=1;UNTIL=20261023T235959Z;X-MYPLAN-DATES=0,7',true,rule,null);
    raise exception 'Pattern with history accepted';
  exception when raise_exception then if SQLERRM not like 'This series has history.%' then raise;end if;end;
  select count(*) into n from public.calendar_entries;
  begin
    perform public.myplan_create_selected_checklist(payload,'FREQ=DAILY;INTERVAL=1;UNTIL=20261023T235959Z;X-MYPLAN-DATES=0,2,2,7');
    raise exception 'Invalid rule accepted';
  exception when raise_exception then if SQLERRM not like 'Choose between%' then raise;end if;end;
  if (select count(*) from public.calendar_entries)<>n then raise exception 'Failed create left a phantom entry';end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000098',true);
  if exists(select 1 from public.calendar_entries where id=entry) then raise exception 'Another owner could see selected Checklist';end if;
  begin
    perform public.myplan_create_selected_checklist(payload,rule);
    raise exception 'Another owner reused Task';
  exception when raise_exception then if SQLERRM not like 'Choose an active Task%' then raise;end if;end;
end $$;
do $$
declare task uuid; entry uuid; rule text:='FREQ=DAILY;INTERVAL=1;UNTIL=20261018T235959Z;X-MYPLAN-DATES=0,2';
begin
  insert into public.tasks(title) values('Inherited Reminder Task') returning id into task;
  entry:=public.myplan_create_selected_checklist(jsonb_build_object('title','Late schedule','task_id',task,'item_type','checklist','timezone','Asia/Ho_Chi_Minh','starts_at','2026-10-16T16:50:00Z','ends_at','2026-10-16T16:59:00Z','notification_offsets','[]'::jsonb),rule);
  perform public.delete_myplan_task(task);
  if not exists(select 1 from public.calendar_entries where id=entry and item_type='reminder' and ends_at='2026-10-16T17:05:00Z') then raise exception 'Inherited Reminder lost dates';end if;
  perform public.myplan_update_calendar_entry(entry,'{"title":"Inherited late Reminder"}',rule,false,rule,null);
  perform public.move_calendar_series(entry,'2026-10-16T16:50:00Z','2026-10-16T17:05:00Z','2026-10-17T16:50:00Z','2026-10-17T17:05:00Z');
  if not exists(select 1 from public.recurrence_rules where calendar_entry_id=entry and rrule='FREQ=DAILY;INTERVAL=1;UNTIL=20261019T235959Z;X-MYPLAN-DATES=0,2') then raise exception 'Inherited Reminder move lost pattern';end if;
end $$;
reset role;
-- Both the durable scheduler and legacy cron must use the sparse pattern.
insert into public.push_subscriptions(owner_user_id,endpoint,p256dh,auth)
values('00000000-0000-4000-8000-000000000099','https://fcm.googleapis.com/fcm/send/synthetic-dates-test','key','auth');
do $$
declare owner uuid:='00000000-0000-4000-8000-000000000099';
begin
  if exists(select 1 from myplan_private.push_candidates(owner,'2026-10-16T01:00:00Z') where occurrence_start='2026-10-17T01:00:00Z') then raise exception 'Scheduler generated unselected day';end if;
  if (select count(*) from myplan_private.push_candidates(owner,'2026-10-16T01:00:00Z'))<>2 then raise exception 'Scheduler did not preserve exactly two unresolved dates';end if;
  if (select count(*) from public.get_due_push_jobs('2026-10-16T01:00:00Z'))<>1 then raise exception 'Legacy cron missed selected date';end if;
  if exists(select 1 from public.get_due_push_jobs('2026-10-17T01:00:00Z')) then raise exception 'Legacy cron generated unselected date';end if;
end $$;
rollback;
