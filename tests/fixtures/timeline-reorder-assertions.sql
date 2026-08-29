-- Regression test against PostgreSQL, including the legacy tasks.position
-- column that SQLite tests cannot detect as a PL/pgSQL variable collision.
begin;
-- New installs no longer create this column, but upgraded production databases
-- retain it from migration 0001. Test that historical schema explicitly.
alter table public.tasks add column if not exists position numeric not null default 0;
insert into auth.users(id,email,email_confirmed_at)
  values('00000000-0000-4000-8000-000000000099','reorder@example.test',now()),
    ('00000000-0000-4000-8000-000000000098','other-reorder@example.test',now());
update myplan_private.members set status='approved',record_limit=1000
  where user_id in ('00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000098');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$
declare
  v_goal uuid;
  v_other_goal uuid;
  v_first uuid;
  v_second uuid;
  v_third uuid;
  v_child uuid;
  v_other_task uuid;
  v_order uuid[];
  v_undo_op uuid := gen_random_uuid();
  v_undo_session uuid := gen_random_uuid();
begin
  insert into public.goals(title) values('Reorder source') returning id into v_goal;
  insert into public.goals(title) values('Reorder destination') returning id into v_other_goal;
  insert into public.tasks(title,goal_id,position) values('First',v_goal,17) returning id into v_first;
  insert into public.tasks(title,goal_id,position) values('Second',v_goal,29) returning id into v_second;
  insert into public.tasks(title,goal_id,position) values('Third',v_goal,41) returning id into v_third;
  insert into public.tasks(title,goal_id,parent_task_id) values('Child',v_goal,v_third) returning id into v_child;
  insert into public.tasks(title,goal_id) values('Destination sibling',v_other_goal) returning id into v_other_task;

  perform set_config('request.headers',jsonb_build_object(
    'x-myplan-undo-operation',v_undo_op,'x-myplan-undo-session',v_undo_session)::text,true);
  perform public.myplan_reorder_timeline('task',v_third,v_goal,v_first);
  perform set_config('request.headers','{}',true);
  select array_agg(t.id order by t.sort_order) into v_order from public.tasks t
    where t.goal_id=v_goal and t.parent_task_id is null;
  if v_order<>array[v_third,v_first,v_second] then raise exception 'Reorder before sibling failed'; end if;
  if (select position from public.tasks where id=v_third)<>41 then raise exception 'Legacy position was changed'; end if;
  perform public.myplan_undo_apply(v_undo_op,v_undo_session);
  perform set_config('myplan.undo_replaying','false',true);
  select array_agg(t.id order by t.sort_order) into v_order from public.tasks t
    where t.goal_id=v_goal and t.parent_task_id is null;
  if v_order<>array[v_first,v_second,v_third] then raise exception 'Reorder Undo failed'; end if;

  perform public.myplan_reorder_timeline('task',v_first,v_goal,null);
  select array_agg(t.id order by t.sort_order) into v_order from public.tasks t
    where t.goal_id=v_goal and t.parent_task_id is null;
  if v_order<>array[v_second,v_third,v_first] then raise exception 'Reorder to end failed'; end if;

  perform public.myplan_reorder_timeline('task',v_third,v_other_goal,v_other_task);
  if not exists(select 1 from public.tasks where id=v_third and goal_id=v_other_goal and parent_task_id is null)
    then raise exception 'Cross-Goal reorder failed'; end if;
  if not exists(select 1 from public.tasks where id=v_child and goal_id=v_goal and parent_task_id is null)
    then raise exception 'Child must remain in old Goal'; end if;
  if (select sort_order from public.tasks where id=v_third)>=(select sort_order from public.tasks where id=v_other_task)
    then raise exception 'Cross-Goal insertion order failed'; end if;
  perform public.myplan_reorder_timeline('task',v_third,null,null);
  if (select goal_id from public.tasks where id=v_third) is not null then raise exception 'Inbox move failed'; end if;

  perform public.myplan_reorder_timeline('goal',v_other_goal,null,v_goal);
  if (select sort_order from public.goals where id=v_other_goal)>=(select sort_order from public.goals where id=v_goal)
    then raise exception 'Goal reorder failed'; end if;

  -- Another approved member must not move this owner's Task or Goal.
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000098',true);
  begin
    perform public.myplan_reorder_timeline('task',v_first,null,null);
    raise exception 'Cross-owner Task reorder allowed';
  exception when raise_exception then if sqlerrm<>'Task not found.' then raise; end if; end;
  begin
    perform public.myplan_reorder_timeline('goal',v_goal,null,null);
    raise exception 'Cross-owner Goal reorder allowed';
  exception when raise_exception then if sqlerrm<>'Goal not found.' then raise; end if; end;
  perform set_config('request.jwt.claim.sub','',true);
  begin
    perform public.myplan_reorder_timeline('task',v_first,null,null);
    raise exception 'Unauthenticated reorder allowed';
  exception when raise_exception then if sqlerrm<>'Approved account required.' then raise; end if; end;
end $$;
rollback;
