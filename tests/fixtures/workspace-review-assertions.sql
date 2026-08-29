-- Fake data only, in network-isolated test container.
insert into auth.users(id,email,email_confirmed_at) values('00000000-0000-4000-8000-000000000099','workspace@example.test',now());
update myplan_private.members set status='approved',record_limit=1000 where user_id='00000000-0000-4000-8000-000000000099';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',false);
select set_config('request.jwt.claim.role','authenticated',false);
do $$ declare color text; parent uuid; child uuid; mark uuid; begin
  foreach color in array array['rose','coral','lime','slate'] loop
    insert into public.goals(user_id,title,color_key) values(auth.uid(),color,color);
  end loop;
  insert into public.goals(user_id,title) values(auth.uid(),'Parent') returning id into parent;
  insert into public.timeline_milestones(owner_user_id,goal_id,title,milestone_on) values(auth.uid(),parent,'Review','2026-09-10') returning id into mark;
  insert into public.planner_annotations(owner_user_id,milestone_id,kind,body) values(auth.uid(),mark,'comment','Preserve this note');
  update public.goals set deleted_at=now() where id=parent;
  perform public.delete_myplan_goal(parent);
  if not exists(select 1 from public.timeline_milestones where id=mark and goal_id is null) then raise exception 'Goal deletion lost milestone'; end if;
  if not exists(select 1 from public.planner_annotations where milestone_id=mark) then raise exception 'Goal deletion lost note'; end if;
  insert into public.tasks(user_id,title) values(auth.uid(),'Task') returning id into child;
  update public.timeline_milestones set task_id=child where id=mark;
  begin
    update public.timeline_milestones set goal_id=(select id from public.goals where title='rose' limit 1) where id=mark;
    raise exception 'Both milestone parents unexpectedly allowed';
  exception when check_violation then null; end;
  begin
    update public.tasks set parent_task_id=child where id=child;
    raise exception 'Self-parent allowed';
  exception when raise_exception then if sqlerrm='Self-parent allowed' then raise; end if; end;
  insert into public.planner_holidays(title,starts_on,ends_on) values('Holiday','2026-09-03','2026-09-04');
end $$;
do $$ declare target uuid; other uuid; begin
  insert into public.goals(user_id,title) values(auth.uid(),'Undo before') returning id into target;
  insert into public.goals(user_id,title) values(auth.uid(),'Other before') returning id into other;
  perform set_config('request.headers','{"x-myplan-undo-operation":"00000000-0000-4000-8000-000000000012","x-myplan-undo-session":"00000000-0000-4000-8000-000000000013"}',true);
  update public.goals set title='Undo after' where id=target;
  update public.goals set title='Other after' where id=other;
  perform set_config('request.headers','{}',true);
  update public.goals set title='Remote change' where id=other;
  begin
    perform public.myplan_undo_apply('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013');
    raise exception 'Conflict did not stop Undo';
  exception when raise_exception then if sqlerrm not like 'Undo conflict:%' then raise; end if; end;
  if (select title from public.goals where id=target)<>'Undo after' then raise exception 'Partial Undo occurred'; end if;
  update public.goals set title='Other after',color_key='coral' where id=other;
  perform public.myplan_undo_apply('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013');
  if (select title from public.goals where id=target)<>'Undo before' then raise exception 'Undo failed'; end if;
  if (select color_key from public.goals where id=other)<>'coral' then raise exception 'Undo lost unrelated edit'; end if;
end $$;
do $$ declare goal_id_value uuid; other_goal uuid; task_id_value uuid; child_id uuid; entry_id uuid; mark_id uuid; plan jsonb; before_start timestamptz; op uuid:='00000000-0000-4000-8000-000000000081';session_value uuid:='00000000-0000-4000-8000-000000000082';begin
  insert into public.goals(title,starts_at,ends_at) values('Move group','2026-09-01','2026-09-30') returning id into goal_id_value;
  insert into public.goals(title) values('Other group') returning id into other_goal;
  insert into public.tasks(title,status,goal_id,planned_start,due_at) values('Move Task','planned',goal_id_value,'2026-09-02','2026-09-10T16:59:00Z') returning id into task_id_value;
  insert into public.tasks(title,status,goal_id,parent_task_id,planned_start) values('Child','planned',goal_id_value,task_id_value,'2026-09-03') returning id into child_id;
  insert into public.timeline_milestones(title,task_id,milestone_on) values('Flag',task_id_value,'2026-09-09') returning id into mark_id;
  insert into public.calendar_entries(title,task_id,starts_at,ends_at,item_type) values('Checklist',task_id_value,'2026-09-03T01:00:00Z','2026-09-03T02:00:00Z','checklist') returning id into entry_id;
  insert into public.recurrence_rules(calendar_entry_id,rrule) values(entry_id,'FREQ=DAILY;UNTIL=20260910T235959Z');
  perform public.myplan_update_occurrence(entry_id,'2026-09-04T01:00:00Z','{"completed_at":"2026-09-04T01:30:00Z","override_starts_at":"2026-09-04T02:00:00Z","override_ends_at":"2026-09-04T03:00:00Z"}');
  plan:=public.myplan_preview_timeline_group(goal_id_value);
  if (plan->>'tasks')::integer<>2 or (plan->>'calendar')::integer<>1 or (plan->>'milestones')::integer<>1 then raise exception 'Group preview counts wrong';end if;
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',session_value)::text,true);
  perform public.myplan_move_timeline_group(goal_id_value,3,plan->>'version');
  perform set_config('request.headers','{}',true);
  if (select planned_start from public.tasks where id=task_id_value)<>'2026-09-05' then raise exception 'Task did not move with Goal';end if;
  if (select milestone_on from public.timeline_milestones where id=mark_id)<>'2026-09-12' then raise exception 'Milestone did not move with Goal';end if;
  if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry_id and occurrence_start='2026-09-07T01:00:00Z' and completed_at is not null) then raise exception 'Occurrence state failed to move';end if;
  perform public.myplan_undo_apply(op,session_value);
  perform set_config('myplan.undo_replaying','false',true);
  if (select starts_at from public.goals where id=goal_id_value)<>'2026-09-01' then raise exception 'Group Undo failed';end if;
  if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry_id and occurrence_start='2026-09-04T01:00:00Z' and override_starts_at='2026-09-04T02:00:00Z') then raise exception 'Group Undo lost override';end if;
  plan:=public.myplan_preview_timeline_group(goal_id_value);update public.tasks set title='New title' where id=task_id_value;
  begin perform public.myplan_move_timeline_group(goal_id_value,2,plan->>'version');raise exception 'Stale preview allowed';exception when raise_exception then if sqlerrm not like 'This group changed.%' then raise;end if;end;
  op:='00000000-0000-4000-8000-000000000083';
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',session_value)::text,true);
  perform public.myplan_move_timeline_task(task_id_value,jsonb_build_object('days',2,'goal_id',other_goal,'expected_goal',goal_id_value,'expected_parent',null,'expected_start','2026-09-02','expected_due','2026-09-10T16:59:00Z'));
  perform set_config('request.headers','{}',true);
  if (select goal_id from public.tasks where id=child_id)<>goal_id_value or (select parent_task_id from public.tasks where id=child_id) is not null then raise exception 'Child moved with single task';end if;
  if (select starts_at from public.calendar_entries where id=entry_id)<>'2026-09-03T01:00:00Z' then raise exception 'Individual task shifted checklist';end if;
  perform public.myplan_undo_apply(op,session_value);
  if (select parent_task_id from public.tasks where id=child_id)<>task_id_value or (select goal_id from public.tasks where id=task_id_value)<>goal_id_value then raise exception 'Task reparent Undo failed';end if;
end $$;

do $$ declare task_id_value uuid;entry_id uuid;begin
  insert into public.tasks(title,status) values('All Done task','planned') returning id into task_id_value;
  insert into public.calendar_entries(title,task_id,starts_at,ends_at,item_type) values('All Done checklist',task_id_value,'2026-09-03T01:00:00Z','2026-09-03T02:00:00Z','checklist') returning id into entry_id;
  perform public.myplan_update_calendar_entry(entry_id,'{"completed_at":"2026-09-03T02:00:00Z"}',null);
  begin perform public.myplan_save_task_edit(task_id_value,'{"title":"Wrong change","status":"planned"}',false);raise exception 'All-Done reopen allowed';exception when raise_exception then if sqlerrm not like '%Reopen a checklist first.%' then raise;end if;end;
  if not exists(select 1 from public.tasks where id=task_id_value and status='completed' and title='All Done task' and completed_at is not null and progress=100) then raise exception 'Rejected edit changed Task';end if;
end $$;
do $$ declare task_value uuid;entry_value uuid;year_value integer;day_value text;before_entry jsonb;before_states jsonb;op uuid:='00000000-0000-4000-8000-000000000091';session_value uuid:='00000000-0000-4000-8000-000000000092';begin
  foreach year_value in array array[2026,2028] loop
    day_value:=case when year_value=2028 then '29' else '28' end;
    insert into public.tasks(title,status) values('Month boundary','planned') returning id into task_value;
    insert into public.calendar_entries(title,task_id,starts_at,ends_at,item_type) values('Monthly',task_value,(year_value||'-01-30T01:00:00Z')::timestamptz,(year_value||'-01-30T02:00:00Z')::timestamptz,'checklist') returning id into entry_value;
    insert into public.recurrence_rules(calendar_entry_id,rrule) values(entry_value,'FREQ=MONTHLY;UNTIL='||year_value||'0330T235959Z');
    perform public.myplan_update_occurrence(entry_value,(year_value||'-02-'||day_value||'T01:00:00Z')::timestamptz,jsonb_build_object('completed_at',year_value||'-02-'||day_value||'T02:00:00Z','override_starts_at',year_value||'-02-'||day_value||'T03:00:00Z','override_ends_at',year_value||'-02-'||day_value||'T04:00:00Z'));
    perform set_config('myplan.undo_replaying','false',true);
    perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',session_value)::text,true);
    perform public.myplan_update_calendar_entry(entry_value,jsonb_build_object('title','Moved metadata','starts_at',year_value||'-02-01T01:00:00Z','ends_at',year_value||'-02-01T02:00:00Z'),null);
    perform set_config('request.headers','{}',true);
    if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry_value and occurrence_start=(year_value||'-03-01T01:00:00Z')::timestamptz and override_starts_at=(year_value||'-03-01T03:00:00Z')::timestamptz and completed_at is not null) then raise exception 'Monthly Done history lost';end if;
    if (select progress from public.tasks where id=task_value)<>33 then raise exception 'Monthly progress changed';end if;
    perform public.myplan_undo_apply(op,session_value);
    if not exists(select 1 from public.calendar_entries where id=entry_value and title='Monthly' and starts_at=(year_value||'-01-30T01:00:00Z')::timestamptz) then raise exception 'Series metadata+schedule Undo not atomic';end if;
    if not exists(select 1 from public.calendar_occurrence_states where calendar_entry_id=entry_value and occurrence_start=(year_value||'-02-'||day_value||'T01:00:00Z')::timestamptz and completed_at is not null) then raise exception 'Monthly Undo history lost';end if;
    -- Metadata-only patches must never replace a newer repeat horizon.
    update public.recurrence_rules set rrule='FREQ=MONTHLY;UNTIL='||year_value||'0430T235959Z' where calendar_entry_id=entry_value;
    perform public.myplan_update_calendar_entry(entry_value,'{"title":"Metadata only"}','FREQ=MONTHLY;UNTIL='||year_value||'0330T235959Z');
    if (select rrule from public.recurrence_rules where calendar_entry_id=entry_value) not like '%0430%' then raise exception 'Metadata overwrote newer recurrence';end if;
    begin
      perform public.myplan_update_calendar_entry(entry_value,'{}','FREQ=DAILY;UNTIL=20260930T235959Z',true,'FREQ=MONTHLY;UNTIL='||year_value||'0330T235959Z');raise exception 'Stale rule allowed';
    exception when raise_exception then if sqlerrm not like 'This repeat rule changed.%' then raise;end if;end;
  end loop;
end $$;
reset role;
