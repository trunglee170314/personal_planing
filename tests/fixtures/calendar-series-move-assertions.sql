-- Disposable network-none PostgreSQL QA only. Never apply to Supabase.
begin;
insert into auth.users(id,email,email_confirmed_at)
values('00000000-0000-4000-8000-000000000097','calendar-scope-audit@example.test',now());
update myplan_private.members set status='approved',record_limit=10000
where user_id='00000000-0000-4000-8000-000000000097';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000097',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare rule text; task uuid; entry uuid; original jsonb; old_states jsonb;
old_state jsonb; actual public.calendar_occurrence_states; state_uuid uuid;
op uuid; sess uuid:=gen_random_uuid(); note uuid; row_count integer;
begin
 foreach rule in array array[
  'FREQ=DAILY;INTERVAL=1;UNTIL=20350115T235959Z',
  'FREQ=WEEKLY;INTERVAL=1;UNTIL=20350115T235959Z',
  'FREQ=MONTHLY;INTERVAL=1;UNTIL=20350301T235959Z',
  'FREQ=DAILY;INTERVAL=3;UNTIL=20350115T235959Z',
  'FREQ=DAILY;INTERVAL=1;UNTIL=20350115T235959Z;X-MYPLAN-DATES=0,2,14'
 ] loop
  insert into public.tasks(title) values('Scope audit') returning id into task;
  insert into public.calendar_entries(task_id,title,starts_at,ends_at,item_type)
  values(task,'Scope audit','2035-01-01T01:00:00Z','2035-01-01T02:00:00Z','checklist') returning id into entry;
  insert into public.recurrence_rules(calendar_entry_id,rrule) values(entry,rule);
  perform public.myplan_update_occurrence(entry,'2035-01-01T01:00:00Z','{"completed_at":"2035-01-01T02:00:00Z","title_override":"Protected first"}');
  perform public.myplan_save_occurrence_annotation(entry,'2035-01-01T01:00:00Z','{"kind":"comment","body":"Occurrence note preserved"}');
  select id into state_uuid from public.calendar_occurrence_states where calendar_entry_id=entry and occurrence_start='2035-01-01T01:00:00Z';
  select id into note from public.planner_annotations where occurrence_state_id=state_uuid;
  select to_jsonb(e) into original from public.calendar_entries e where id=entry;
  perform public.myplan_revise_calendar_series(entry,original||'{"title":"Materialized scope audit"}',rule,'series',null,original,rule);
  select count(*) into row_count from public.calendar_occurrence_states where calendar_entry_id=entry;
  if row_count<3 or not(select occurrence_mode from public.calendar_entries where id=entry) then raise exception 'Materialization setup failed: %',rule;end if;
  select jsonb_agg(to_jsonb(s) order by id) into old_states from public.calendar_occurrence_states s where calendar_entry_id=entry;
  op:=gen_random_uuid();
  perform set_config('myplan.undo_replaying','false',true);
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
  perform public.move_calendar_series(entry,'2035-01-01T01:00:00Z','2035-01-01T02:00:00Z','2035-01-02T02:00:00Z','2035-01-02T03:00:00Z');
  perform set_config('request.headers','{}',true);
  if (select count(*) from public.calendar_occurrence_states where calendar_entry_id=entry)<>row_count then raise exception 'Move lost membership: %',rule;end if;
  for old_state in select value from jsonb_array_elements(old_states) loop
   select * into actual from public.calendar_occurrence_states where id=(old_state->>'id')::uuid;
   if actual.occurrence_start is distinct from (old_state->>'occurrence_start')::timestamptz+interval '25 hours'
    or actual.override_starts_at is distinct from (old_state->>'override_starts_at')::timestamptz+interval '25 hours'
    or actual.override_ends_at is distinct from (old_state->>'override_ends_at')::timestamptz+interval '25 hours'
    or actual.completed_at is distinct from (old_state->>'completed_at')::timestamptz
    or actual.not_needed_at is distinct from (old_state->>'not_needed_at')::timestamptz
    or actual.title_override is distinct from (old_state->>'title_override')
   then raise exception 'Whole-series shift/identity/outcome/title mismatch: %',rule;end if;
  end loop;
  if not exists(select 1 from public.planner_annotations where id=note and occurrence_state_id=state_uuid) then raise exception 'Move lost note identity';end if;
  perform public.myplan_undo_apply(op,sess);
  for old_state in select value from jsonb_array_elements(old_states) loop
   select * into actual from public.calendar_occurrence_states where id=(old_state->>'id')::uuid;
   if actual.occurrence_start is distinct from (old_state->>'occurrence_start')::timestamptz
    or actual.override_starts_at is distinct from (old_state->>'override_starts_at')::timestamptz
    or actual.override_ends_at is distinct from (old_state->>'override_ends_at')::timestamptz
   then raise exception 'Whole-series Undo mismatch: %',rule;end if;
  end loop;
 end loop;
end $$;
rollback;
