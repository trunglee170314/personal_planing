-- Disposable PostgreSQL only. Never apply this fixture to Supabase.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000099','milestone@example.test',now()),
 ('00000000-0000-4000-8000-000000000098','other-milestone@example.test',now());
update myplan_private.members set status='approved',record_limit=1000;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare g uuid; m uuid; before_row jsonb; after_row jsonb; plan jsonb; affected integer;
  op uuid := '00000000-0000-4000-8000-000000000031';
  sess uuid := '00000000-0000-4000-8000-000000000032';
begin
  insert into public.goals(title,starts_at,ends_at) values('Milestone group','2026-10-01','2026-10-31') returning id into g;
  insert into public.timeline_milestones(title,goal_id,milestone_on,color_key) values('Launch',g,'2026-10-15','jade') returning id into m;
  select to_jsonb(t) into before_row from public.timeline_milestones t where id=m;
  if before_row->'is_important' <> 'false'::jsonb then raise exception 'Normal default missing'; end if;
  perform set_config('request.headers',jsonb_build_object('x-myplan-undo-operation',op,'x-myplan-undo-session',sess)::text,true);
  update public.timeline_milestones set is_important=true where id=m;
  perform set_config('request.headers','{}',true);
  select to_jsonb(t) into after_row from public.timeline_milestones t where id=m;
  if (before_row - 'is_important' - 'updated_at') <> (after_row - 'is_important' - 'updated_at') then raise exception 'Importance changed unrelated milestone data'; end if;
  perform public.myplan_undo_apply(op,sess);
  perform set_config('myplan.undo_replaying','false',true);
  if (select is_important from public.timeline_milestones where id=m) then raise exception 'Importance Undo failed'; end if;
  update public.timeline_milestones set is_important=true where id=m;
  plan:=public.myplan_preview_timeline_group(g);
  perform public.myplan_move_timeline_group(g,1,plan->>'version');
  if not exists(select 1 from public.timeline_milestones where id=m and is_important and milestone_on='2026-10-16') then raise exception 'Group move lost importance'; end if;
  begin
    update public.timeline_milestones set is_important=null where id=m;
    raise exception 'Null importance accepted';
  exception when not_null_violation then null; end;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000098',true);
  if exists(select 1 from public.timeline_milestones where id=m) then raise exception 'Another owner could see milestone'; end if;
  update public.timeline_milestones set is_important=false where id=m;
  get diagnostics affected=row_count;
  if affected<>0 then raise exception 'Another owner could edit importance'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
  if not (select is_important from public.timeline_milestones where id=m) then raise exception 'Owner isolation failed'; end if;
end $$;
rollback;
