-- ONLY for disposable network-isolated PostgreSQL. Never apply to Supabase.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000099','repeat@example.test',now()),
 ('00000000-0000-4000-8000-000000000098','other-repeat@example.test',now());
update myplan_private.members set status='approved',record_limit=5000;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare task uuid; entry uuid; before_row jsonb; next_row jsonb; rule text; note_state uuid; note_uuid uuid;
 op uuid:='00000000-0000-4000-8000-000000000033';sess uuid:='00000000-0000-4000-8000-000000000034';
begin
 insert into public.tasks(title) values('Repeat Task') returning id into task;
 insert into public.calendar_entries(task_id,title,starts_at,ends_at,notification_offsets) values(task,'Original','2035-01-01T01:00:00Z','2035-01-01T02:00:00Z',array[0]) returning id into entry;
 rule:='FREQ=DAILY;INTERVAL=1;UNTIL=20350103T235959Z';
 insert into public.recurrence_rules(calendar_entry_id,rrule) values(entry,rule);
 insert into public.planner_annotations(calendar_entry_id,kind,body) values(entry,'comment','Legacy series notes');
 perform public.myplan_save_occurrence_annotation(entry,'2035-01-02T01:00:00Z','{"kind":"comment","body":"Jan2 only"}');
 select id into note_state from public.calendar_occurrence_states where calendar_entry_id=entry and occurrence_start='2035-01-02T01:00:00Z';
 select id into note_uuid from public.planner_annotations where occurrence_state_id=note_state;
 if (select count(*) from public.planner_annotations where calendar_entry_id=entry and occurrence_state_id is null)<>1 then raise exception 'Legacy notes scope changed';end if;
 perform public.myplan_update_occurrence(entry,'2035-01-01T01:00:00Z','{"completed_at":"2035-01-01T02:00:00Z"}');
 perform public.myplan_update_occurrence(entry,'2035-01-03T01:00:00Z','{"override_starts_at":"2035-02-03T03:00:00Z","override_ends_at":"2035-02-03T04:00:00Z","title_override":"Special occurrence"}');
 select to_jsonb(e) into before_row from public.calendar_entries e where id=entry;
 next_row:=before_row;
 perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
 perform public.myplan_revise_calendar_series(entry,next_row,'FREQ=WEEKLY;INTERVAL=1;UNTIL=20350115T235959Z','series',null,before_row,rule);
 perform set_config('request.headers','{}',true);
 if not (select occurrence_mode from public.calendar_entries where id=entry) then raise exception 'Effective mode missing';end if;
 if (select count(*) from public.calendar_occurrence_states where calendar_entry_id=entry)<>5 then raise exception 'History or weekly instances lost';end if;
 if (select progress from public.tasks where id=task)<>20 then raise exception 'Materialized progress incorrect';end if;
 if not exists(select 1 from public.planner_annotations where id=note_uuid and occurrence_state_id=note_state) then raise exception 'Comment identity moved';end if;
 perform public.myplan_undo_apply(op,sess);
 perform set_config('myplan.undo_replaying','false',true);
 if (select occurrence_mode from public.calendar_entries where id=entry) then raise exception 'Undo did not restore generator mode';end if;
 if (select progress from public.tasks where id=task)<>33 then raise exception 'Undo progress incorrect';end if;
 select to_jsonb(e) into before_row from public.calendar_entries e where id=entry;
 next_row:=before_row||'{"title":"Following title","starts_at":"2035-01-02T01:00:00Z","ends_at":"2035-01-02T02:00:00Z"}';
 perform public.myplan_revise_calendar_series(entry,next_row,'FREQ=WEEKLY;INTERVAL=1;UNTIL=20350116T235959Z','future','2035-01-02T01:00:00Z',before_row,rule);
 if (select count(*) from public.calendar_occurrence_states where calendar_entry_id=entry)<>5 then raise exception 'Following cut lost identities';end if;
 if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry and occurrence_start='2035-01-01T01:00:00Z' and title_override='Original') then raise exception 'Pre-cut title changed';end if;
 select to_jsonb(e) into before_row from public.calendar_entries e where id=entry;
 rule:='FREQ=WEEKLY;INTERVAL=1;UNTIL=20350116T235959Z';
 perform public.myplan_revise_calendar_series(entry,before_row||'{"title":"Third title"}',rule,'series',null,before_row,rule);
 if exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry and title_override='Original') then raise exception 'Auto title did not follow entire rename';end if;
 if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry and title_override='Special occurrence' and override_starts_at='2035-02-03T03:00:00Z') then raise exception 'Explicit exception lost';end if;
 select to_jsonb(e) into before_row from public.calendar_entries e where id=entry;
 next_row:=before_row||'{"starts_at":"2035-01-09T01:00:00Z","ends_at":"2035-01-09T02:00:00Z"}';
 perform public.myplan_revise_calendar_series(entry,next_row,null,'future','2035-01-09T01:00:00Z',before_row,rule);
 if (select count(*) from public.calendar_occurrence_states where calendar_entry_id=entry)<>4 then raise exception 'Materialized None lost history';end if;
 perform public.set_myplan_task_completion(task,true);
 if exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry and completed_at is null and not_needed_at is null) then raise exception 'Complete missed None mode';end if;
 perform public.set_myplan_task_completion(task,false);
 if (select progress from public.tasks where id=task)<>25 then raise exception 'Reopen lost original Done';end if;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000098',true);
 if exists(select 1 from public.planner_annotations where id=note_uuid) then raise exception 'Another owner read notes';end if;
 begin
  perform public.myplan_save_occurrence_annotation(entry,'2035-01-02T01:00:00Z','{"kind":"comment","body":"Foreign"}');
  raise exception 'Another owner wrote notes';
 exception when raise_exception then if SQLERRM not like 'Calendar item not found.%' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
do $$
declare task uuid; entry uuid;
begin
 insert into public.tasks(title) values('Long legacy Task') returning id into task;
 insert into public.calendar_entries(task_id,title,starts_at,ends_at) values(task,'Long legacy','2030-01-01T01:00:00Z','2030-01-01T02:00:00Z') returning id into entry;
 insert into public.recurrence_rules(calendar_entry_id,rrule) values(entry,'FREQ=DAILY;INTERVAL=1;UNTIL=20351231T235959Z');
 perform public.myplan_update_occurrence(entry,'2035-01-01T01:00:00Z','{"completed_at":"2035-01-01T02:00:00Z"}');
 perform public.myplan_save_occurrence_annotation(entry,'2035-01-01T01:00:00Z','{"kind":"comment","body":"Beyond1000"}');
 if not exists(select 1 from public.planner_annotations where calendar_entry_id=entry and occurrence_state_id is not null) then raise exception 'Long series comment failed';end if;
end $$;
do $$
declare task uuid; entry uuid; state_id uuid;
begin
 insert into public.tasks(title) values('Reminder conversion Task') returning id into task;
 insert into public.calendar_entries(task_id,title,starts_at,ends_at) values(task,'Late inherited','2035-01-01T16:50:00Z','2035-01-01T16:59:00Z') returning id into entry;
 insert into public.recurrence_rules(calendar_entry_id,rrule) values(entry,'FREQ=DAILY;INTERVAL=1;UNTIL=20350103T235959Z');
 perform public.myplan_update_occurrence(entry,'2035-01-01T16:50:00Z','{"completed_at":"2035-01-01T16:59:00Z"}');
 perform public.myplan_save_occurrence_annotation(entry,'2035-01-02T16:50:00Z','{"kind":"comment","body":"Keep on conversion"}');
 select id into state_id from public.calendar_occurrence_states where calendar_entry_id=entry and occurrence_start='2035-01-02T16:50:00Z';
 perform public.delete_myplan_task(task);
 if exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry and (override_starts_at is null or override_ends_at<>override_starts_at+interval '15 minutes')) then raise exception 'Inherited Reminder duration invalid';end if;
 if not exists(select 1 from public.planner_annotations where calendar_entry_id=entry and occurrence_state_id=state_id) then raise exception 'Task conversion lost comment';end if;
end $$;
reset role;
insert into public.push_subscriptions(owner_user_id,endpoint,p256dh,auth) values('00000000-0000-4000-8000-000000000099','https://web.push.apple.com/repeat-test','test','test');
do $$
begin
 if not exists(select 1 from myplan_private.push_candidates('00000000-0000-4000-8000-000000000099','2035-01-01T01:00:00Z') where item_title='Special occurrence' and due_at='2035-02-03T03:00:00Z') then raise exception 'Materialized push lost occurrence title or moved time';end if;
 if not exists(select 1 from public.get_due_push_jobs('2035-02-03T03:00:00Z') where item_title='Special occurrence') then raise exception 'Legacy push lost materialized occurrence';end if;
end $$;
rollback;
