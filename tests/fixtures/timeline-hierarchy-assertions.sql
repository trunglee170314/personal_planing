-- ONLY for disposable network-isolated PostgreSQL. Never apply to Supabase.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000081','hierarchy@example.test',now()),
 ('00000000-0000-4000-8000-000000000082','other-hierarchy@example.test',now()),
 ('00000000-0000-4000-8000-000000000083','pending-hierarchy@example.test',now());
update myplan_private.members set status='approved',record_limit=5000
 where user_id in ('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000082');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare
  goal_a uuid; goal_b uuid; source uuid; child uuid; grandchild uuid;
  destination uuid; peer uuid; other_goal_task uuid; inbox_task uuid; inbox_target uuid;
  archived_task uuid; deleted_task uuid; entry_id uuid;
  plan jsonb; version text; before_tasks jsonb; after_tasks jsonb;
  root_metadata jsonb; descendants jsonb; associated jsonb; goal_before jsonb;
  op uuid:='00000000-0000-4000-8000-000000000081';
  sess uuid:='00000000-0000-4000-8000-000000000082';
begin
  insert into public.goals(title) values('Hierarchy Goal A') returning id into goal_a;
  insert into public.goals(title) values('Hierarchy Goal B') returning id into goal_b;
  insert into public.tasks(title,goal_id,planned_start,planned_end,due_at,status,priority,link_url)
    values('Source branch',goal_a,'2035-01-01','2035-02-01','2035-02-01T12:00Z','planned','high','https://example.test/task') returning id into source;
  insert into public.tasks(title,goal_id,parent_task_id,status)
    values('Child',goal_a,source,'completed') returning id into child;
  insert into public.tasks(title,goal_id,parent_task_id) values('Grandchild',goal_a,child) returning id into grandchild;
  insert into public.tasks(title,goal_id) values('Destination',goal_a) returning id into destination;
  insert into public.tasks(title,goal_id,parent_task_id) values('Existing child',goal_a,destination) returning id into peer;
  insert into public.tasks(title,goal_id) values('Different Goal',goal_b) returning id into other_goal_task;
  insert into public.tasks(title) values('Inbox branch') returning id into inbox_task;
  insert into public.tasks(title) values('Inbox parent') returning id into inbox_target;
  insert into public.tasks(title,goal_id,archived_at) values('Archived target',goal_a,now()) returning id into archived_task;
  insert into public.tasks(title,goal_id,deleted_at) values('Deleted target',goal_a,now()) returning id into deleted_task;
  insert into public.timeline_milestones(task_id,title,milestone_on,is_important)
    values(child,'Unchanged milestone','2035-01-12',true);
  insert into public.calendar_entries(task_id,title,starts_at,ends_at,item_type,is_pinned)
    values(child,'Unchanged checklist','2035-01-12T01:00Z','2035-01-12T01:15Z','checklist',true) returning id into entry_id;
  perform public.myplan_save_occurrence_annotation(entry_id,'2035-01-12T01:00Z','{"kind":"comment","body":"Keep this branch note"}');
  select to_jsonb(t)-array['parent_task_id','sort_order','updated_at'] into root_metadata from public.tasks t where id=source;
  select jsonb_agg(to_jsonb(t) order by id) into descendants from public.tasks t where id in(child,grandchild);
  select jsonb_build_object('milestones',(select jsonb_agg(to_jsonb(m) order by id) from public.timeline_milestones m),
    'entries',(select jsonb_agg(to_jsonb(e) order by id) from public.calendar_entries e),
    'annotations',(select jsonb_agg(to_jsonb(a) order by id) from public.planner_annotations a),
    'states',(select jsonb_agg(to_jsonb(s) order by id) from public.calendar_occurrence_states s)) into associated;
  select to_jsonb(g)-'updated_at' into goal_before from public.goals g where id=goal_a;
  select jsonb_agg(to_jsonb(t)-'updated_at' order by id) into before_tasks from public.tasks t;
  plan:=public.myplan_preview_timeline_hierarchy(source);
  if length(plan->>'version')<16 or jsonb_array_length(plan->'tree')<>8
    or exists(select 1 from jsonb_array_elements(plan->'tree') item
      where (select count(*) from jsonb_object_keys(item))<>4) then
    raise exception 'Preview must return only the active structural tree and opaque version';
  end if;
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
  perform public.myplan_restructure_timeline(source,'task',destination,'inside',plan->>'version');
  perform set_config('request.headers','{}',true);
  if (select parent_task_id from public.tasks where id=source) is distinct from destination
    or (select array_agg(id order by sort_order,created_at,id) from public.tasks where parent_task_id=destination) is distinct from array[peer,source] then
    raise exception 'Inside must append the whole branch after existing children';
  end if;
  if (select to_jsonb(t)-array['parent_task_id','sort_order','updated_at'] from public.tasks t where id=source) is distinct from root_metadata
    or (select jsonb_agg(to_jsonb(t) order by id) from public.tasks t where id in(child,grandchild)) is distinct from descendants then
    raise exception 'Hierarchy move changed Task metadata or descendants';
  end if;
  if (select jsonb_build_object('milestones',(select jsonb_agg(to_jsonb(m) order by id) from public.timeline_milestones m),
    'entries',(select jsonb_agg(to_jsonb(e) order by id) from public.calendar_entries e),
    'annotations',(select jsonb_agg(to_jsonb(a) order by id) from public.planner_annotations a),
    'states',(select jsonb_agg(to_jsonb(s) order by id) from public.calendar_occurrence_states s))) is distinct from associated then
    raise exception 'Hierarchy move changed associated schedule, milestone or note';
  end if;
  if not public.myplan_undo_ready(op,sess) then raise exception 'Hierarchy move did not create Undo';end if;
  perform public.myplan_undo_apply(op,sess);
  perform set_config('myplan.undo_replaying','false',true);
  select jsonb_agg(to_jsonb(t)-'updated_at' order by id) into after_tasks from public.tasks t;
  if after_tasks is distinct from before_tasks
    or (select to_jsonb(g)-'updated_at' from public.goals g where id=goal_a) is distinct from goal_before then
    raise exception 'Undo did not restore exact branch hierarchy, ordering and Goal aggregates';
  end if;

  version:=public.myplan_preview_timeline_hierarchy(source)->>'version';
  perform public.myplan_restructure_timeline(source,'task',peer,'before',version);
  if (select array_agg(id order by sort_order,created_at,id) from public.tasks where parent_task_id=destination) is distinct from array[source,peer] then
    raise exception 'Before must adopt the target parent';end if;
  version:=public.myplan_preview_timeline_hierarchy(source)->>'version';
  perform public.myplan_restructure_timeline(source,'task',peer,'after',version);
  if (select array_agg(id order by sort_order,created_at,id) from public.tasks where parent_task_id=destination) is distinct from array[peer,source] then
    raise exception 'After must adopt the target parent';end if;
  version:=public.myplan_preview_timeline_hierarchy(source)->>'version';
  perform public.myplan_restructure_timeline(source,'goal',goal_a,'inside',version);
  if (select parent_task_id from public.tasks where id=source) is not null
    or (select array_agg(id order by sort_order,created_at,id) from public.tasks where goal_id=goal_a and parent_task_id is null and archived_at is null and deleted_at is null) is distinct from array[destination,source] then
    raise exception 'Goal drop must append at root';end if;
  version:=public.myplan_preview_timeline_hierarchy(source)->>'version';
  select jsonb_agg(to_jsonb(t) order by id) into before_tasks from public.tasks t;
  begin perform public.myplan_restructure_timeline(source,'goal',goal_a,'inside',version);
    raise exception 'Accepted no-op';exception when raise_exception then if SQLERRM not like 'Task is already in this position.%' then raise;end if;end;
  if (select jsonb_agg(to_jsonb(t) order by id) from public.tasks t) is distinct from before_tasks then
    raise exception 'A no-op drop must not rewrite any Task';end if;

  -- Every rejection runs in a subtransaction; no partial parent/order changes.
  begin perform public.myplan_restructure_timeline(source,'task',grandchild,'inside',version);
    raise exception 'Accepted cycle';exception when raise_exception then if SQLERRM not like 'A Task cannot be moved into its own subtree.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'task',child,'before',version);
    raise exception 'Accepted descendant sibling drop';exception when raise_exception then if SQLERRM not like 'A Task cannot be moved into its own subtree.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'task',source,'after',version);
    raise exception 'Accepted self';exception when raise_exception then if SQLERRM not like 'A Task cannot be dropped on itself.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'task',other_goal_task,'inside',version);
    raise exception 'Accepted cross Goal';exception when raise_exception then if SQLERRM not like 'Hierarchy moves must stay within the same Goal.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'goal',null,'inside',version);
    raise exception 'Accepted Goal to Inbox';exception when raise_exception then if SQLERRM not like 'Hierarchy moves must stay within the same Goal.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'task',archived_task,'inside',version);
    raise exception 'Accepted archived target';exception when raise_exception then if SQLERRM not like 'Target Task not found.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'task',deleted_task,'inside',version);
    raise exception 'Accepted deleted target';exception when raise_exception then if SQLERRM not like 'Target Task not found.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'goal',goal_a,'after',version);
    raise exception 'Accepted invalid placement';exception when raise_exception then if SQLERRM not like 'Invalid hierarchy drop.%' then raise;end if;end;
  if (select jsonb_agg(to_jsonb(t) order by id) from public.tasks t) is distinct from before_tasks then
    raise exception 'Rejected hierarchy move left a partial write';end if;
  update public.tasks set title='Concurrent change' where id=inbox_target;
  begin perform public.myplan_restructure_timeline(source,'task',destination,'inside',version);
    raise exception 'Accepted stale snapshot';exception when raise_exception then if SQLERRM not like 'This outline changed.%' then raise;end if;end;
  version:=public.myplan_preview_timeline_hierarchy(inbox_task)->>'version';
  perform public.myplan_restructure_timeline(inbox_task,'task',inbox_target,'inside',version);
  version:=public.myplan_preview_timeline_hierarchy(inbox_task)->>'version';
  perform public.myplan_restructure_timeline(inbox_task,'goal',null,'inside',version);
  if (select parent_task_id from public.tasks where id=inbox_task) is not null then raise exception 'Inbox root drop failed';end if;
  version:=public.myplan_preview_timeline_hierarchy(other_goal_task)->>'version';
  update public.goals set status='archived' where id=goal_b;
  begin perform public.myplan_preview_timeline_hierarchy(other_goal_task);
    raise exception 'Preview accepted inactive source Goal';exception when raise_exception then if SQLERRM not like 'Task Goal is not active.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(other_goal_task,'goal',goal_b,'inside',version);
    raise exception 'Accepted inactive Goal';exception when raise_exception then if SQLERRM not like 'Task Goal is not active.%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000082',true);
  begin perform public.myplan_preview_timeline_hierarchy(source);
    raise exception 'Other owner previewed tree';exception when raise_exception then if SQLERRM not like 'Task not found.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'goal',goal_a,'inside',version);
    raise exception 'Other owner moved branch';exception when raise_exception then if SQLERRM not like 'Task not found.%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000083',true);
  begin perform public.myplan_preview_timeline_hierarchy(source);
    raise exception 'Pending account previewed';exception when raise_exception then if SQLERRM not like 'Approved account required.%' then raise;end if;end;
  begin perform public.myplan_restructure_timeline(source,'goal',goal_a,'inside',version);
    raise exception 'Pending account moved';exception when raise_exception then if SQLERRM not like 'Approved account required.%' then raise;end if;end;
end $$;
-- Seed malformed legacy trees ONLY in this disposable database, then restore
-- the real guard before exercising the public RPC as an authenticated owner.
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
insert into public.tasks(id,user_id,title) values
 ('00000000-0000-4000-8100-000000000001','00000000-0000-4000-8000-000000000081','Legacy cycle A'),
 ('00000000-0000-4000-8100-000000000002','00000000-0000-4000-8000-000000000081','Legacy cycle B'),
 ('00000000-0000-4000-8100-000000000003','00000000-0000-4000-8000-000000000081','Healthy branch'),
 ('00000000-0000-4000-8100-000000000004','00000000-0000-4000-8000-000000000081','Archived ancestor'),
 ('00000000-0000-4000-8100-000000000005','00000000-0000-4000-8000-000000000081','Hidden ancestor child');
alter table public.tasks disable trigger task_hierarchy;
update public.tasks set parent_task_id='00000000-0000-4000-8100-000000000002' where id='00000000-0000-4000-8100-000000000001';
update public.tasks set parent_task_id='00000000-0000-4000-8100-000000000001' where id='00000000-0000-4000-8100-000000000002';
update public.tasks set parent_task_id='00000000-0000-4000-8100-000000000004' where id='00000000-0000-4000-8100-000000000005';
update public.tasks set archived_at=now() where id='00000000-0000-4000-8100-000000000004';
alter table public.tasks enable trigger task_hierarchy;
set local role authenticated;
do $$ declare version text; target uuid; begin
  version:=public.myplan_preview_timeline_hierarchy('00000000-0000-4000-8100-000000000003')->>'version';
  foreach target in array array['00000000-0000-4000-8100-000000000001'::uuid,'00000000-0000-4000-8100-000000000005'::uuid] loop
    begin perform public.myplan_restructure_timeline('00000000-0000-4000-8100-000000000003','task',target,'inside',version);
      raise exception 'Accepted damaged destination';exception when raise_exception then if SQLERRM not like 'This Task hierarchy needs repair before moving it.%' then raise;end if;end;
  end loop;
  if (select parent_task_id from public.tasks where id='00000000-0000-4000-8100-000000000003') is not null then
    raise exception 'A damaged target changed the healthy branch';end if;
end $$;
rollback;
