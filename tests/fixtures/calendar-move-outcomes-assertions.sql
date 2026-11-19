-- ONLY for disposable network-isolated PostgreSQL. Never apply to Supabase.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000094','move-outcomes@example.test',now()),
 ('00000000-0000-4000-8000-000000000095','other-move-outcomes@example.test',now()),
 ('00000000-0000-4000-8000-000000000096','pending-move-outcomes@example.test',now());
update myplan_private.members set status='approved',record_limit=5000
 where user_id in ('00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000095');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000094',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$
declare
  task uuid; done_entry uuid; skipped_entry uuid; open_entry uuid;
  state_id uuid; note_id uuid; before_state jsonb; after_state jsonb;
  before_batch jsonb; after_batch jsonb; before_progress integer;
  op uuid:='00000000-0000-4000-8000-000000000094';
  sess uuid:='00000000-0000-4000-8000-000000000095';
begin
  insert into public.tasks(title) values('Move outcome Task') returning id into task;
  insert into public.calendar_entries(task_id,title,starts_at,ends_at,completed_at)
    values(task,'Inherited Done','2035-01-01T01:00:00Z','2035-01-01T02:00:00Z','2035-01-01T02:00:00Z')
    returning id into done_entry;
  insert into public.recurrence_rules(calendar_entry_id,rrule)
    values(done_entry,'FREQ=DAILY;INTERVAL=1;UNTIL=20350103T235959Z');
  perform public.myplan_move_occurrences(done_entry,'[{"occurrence_start":"2035-01-01T01:00:00Z","override_starts_at":"2035-01-01T03:00:00Z","override_ends_at":"2035-01-01T04:00:00Z","completed_at":null,"not_needed_at":"2035-01-01T05:00:00Z"}]');
  if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=done_entry
    and occurrence_start='2035-01-01T01:00:00Z' and completed_at='2035-01-01T02:00:00Z'
    and not_needed_at is null and override_starts_at='2035-01-01T03:00:00Z') then
    raise exception 'Schedule move lost the inherited Done outcome';
  end if;

  perform public.myplan_save_occurrence_annotation(done_entry,'2035-01-01T01:00:00Z','{"kind":"comment","body":"Independent note"}');
  select id,to_jsonb(s) into state_id,before_state from public.calendar_occurrence_states s
    where calendar_entry_id=done_entry and occurrence_start='2035-01-01T01:00:00Z';
  select id into note_id from public.planner_annotations where occurrence_state_id=state_id;
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
  perform public.myplan_move_occurrences(done_entry,'[{"occurrence_start":"2035-01-01T01:00:00Z","override_starts_at":"2035-01-05T03:00:00Z","override_ends_at":"2035-01-05T04:00:00Z","completed_at":null,"not_needed_at":"2035-01-01T05:00:00Z"}]');
  perform set_config('request.headers','{}',true);
  if not exists(select 1 from public.calendar_occurrence_states where id=state_id
    and completed_at='2035-01-01T02:00:00Z' and not_needed_at is null
    and override_starts_at='2035-01-05T03:00:00Z') then
    raise exception 'Stale outcomes replaced the current state during a move';
  end if;
  if not exists(select 1 from public.planner_annotations where id=note_id and occurrence_state_id=state_id) then
    raise exception 'Moving changed the occurrence note UUID';
  end if;
  perform public.myplan_undo_apply(op,sess);
  perform set_config('myplan.undo_replaying','false',true);
  select to_jsonb(s) into after_state from public.calendar_occurrence_states s where id=state_id;
  if before_state-'updated_at' is distinct from after_state-'updated_at' then
    raise exception 'Move Undo did not restore the exact original state';
  end if;
  if not exists(select 1 from public.planner_annotations where id=note_id and occurrence_state_id=state_id) then
    raise exception 'Move Undo changed the occurrence note identity';
  end if;

  perform public.myplan_update_occurrence(done_entry,'2035-01-02T01:00:00Z','{"completed_at":null,"not_needed_at":null}');
  select id into state_id from public.calendar_occurrence_states where calendar_entry_id=done_entry and occurrence_start='2035-01-02T01:00:00Z';
  perform public.myplan_move_occurrences(done_entry,'[{"occurrence_start":"2035-01-02T01:00:00Z","override_starts_at":"2035-01-02T03:00:00Z","override_ends_at":"2035-01-02T04:00:00Z","completed_at":"2035-01-01T02:00:00Z"}]');
  if not exists(select 1 from public.calendar_occurrence_states where id=state_id
    and completed_at is null and not_needed_at is null and override_starts_at='2035-01-02T03:00:00Z') then
    raise exception 'An explicitly Open occurrence inherited the base Done outcome again';
  end if;

  insert into public.calendar_entries(task_id,title,starts_at,ends_at,not_needed_at)
    values(task,'Inherited Not needed','2035-02-01T01:00:00Z','2035-02-01T02:00:00Z','2035-02-01T02:00:00Z')
    returning id into skipped_entry;
  insert into public.recurrence_rules(calendar_entry_id,rrule)
    values(skipped_entry,'FREQ=DAILY;INTERVAL=1;UNTIL=20350203T235959Z');
  perform public.myplan_move_occurrences(skipped_entry,'[{"occurrence_start":"2035-02-01T01:00:00Z","override_starts_at":"2035-02-01T03:00:00Z","override_ends_at":"2035-02-01T04:00:00Z"}]');
  if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=skipped_entry
    and occurrence_start='2035-02-01T01:00:00Z' and completed_at is null and not_needed_at='2035-02-01T02:00:00Z') then
    raise exception 'Schedule move lost the inherited Not needed outcome';
  end if;

  insert into public.calendar_entries(task_id,title,starts_at,ends_at)
    values(task,'Open batch','2035-03-01T01:00:00Z','2035-03-01T02:00:00Z') returning id into open_entry;
  insert into public.recurrence_rules(calendar_entry_id,rrule)
    values(open_entry,'FREQ=DAILY;INTERVAL=1;UNTIL=20350303T235959Z');
  select coalesce(jsonb_agg(to_jsonb(s) order by occurrence_start),'[]') into before_batch
    from public.calendar_occurrence_states s where calendar_entry_id=open_entry;
  select progress into before_progress from public.tasks where id=task;
  begin
    perform public.myplan_move_occurrences(open_entry,'[{"occurrence_start":"2035-03-01T01:00:00Z","override_starts_at":"2035-03-01T03:00:00Z","override_ends_at":"2035-03-01T04:00:00Z"},{"occurrence_start":"2035-03-02T01:00:00Z","override_starts_at":"2035-03-02T04:00:00Z","override_ends_at":"2035-03-02T03:00:00Z"}]');
    raise exception 'An invalid later move was accepted';
  exception when raise_exception then
    if SQLERRM not like 'Invalid occurrence time range.%' then raise;end if;
  end;
  select coalesce(jsonb_agg(to_jsonb(s) order by occurrence_start),'[]') into after_batch
    from public.calendar_occurrence_states s where calendar_entry_id=open_entry;
  if before_batch is distinct from after_batch or (select progress from public.tasks where id=task)<>before_progress then
    raise exception 'A failed move batch left partial data or progress';
  end if;
  perform public.myplan_move_occurrences(open_entry,'[{"occurrence_start":"2035-03-01T01:00:00Z","override_starts_at":"2035-03-01T03:00:00Z","override_ends_at":"2035-03-01T04:00:00Z","completed_at":"2035-03-01T05:00:00Z"}]');
  if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=open_entry
    and occurrence_start='2035-03-01T01:00:00Z' and completed_at is null and not_needed_at is null) then
    raise exception 'A stale move payload completed an Open occurrence';
  end if;

  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000095',true);
  begin
    perform public.myplan_move_occurrences(done_entry,'[]');
    raise exception 'Another owner moved this entry';
  exception when raise_exception then
    if SQLERRM not like 'Calendar item not found.%' then raise;end if;
  end;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000096',true);
  begin
    perform public.myplan_move_occurrences(done_entry,'[]');
    raise exception 'An unapproved account moved this entry';
  exception when raise_exception then
    if SQLERRM not like 'Approved account required.%' then raise;end if;
  end;
end $$;
rollback;
