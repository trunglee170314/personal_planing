\set ON_ERROR_STOP on
select public.bootstrap_myplan_admin('owner@example.test');
insert into auth.users(id,email,email_confirmed_at) values
('00000000-0000-4000-8000-000000000003','pending@example.test',now());
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
do $$ begin
  if public.get_myplan_access()->>'status'<>'pending' then raise exception 'new user must await approval'; end if;
  begin
    insert into public.goals(title) values('must fail');
    raise exception 'pending user inserted a goal';
  exception when insufficient_privilege then null; end;
  begin
    perform public.admin_myplan_users();
    raise exception 'pending user accessed admin data';
  exception when insufficient_privilege then null; end;
  begin
    perform public.bootstrap_myplan_admin('pending@example.test');
    raise exception 'user bootstrapped themselves';
  exception when insufficient_privilege then null; end;
  begin
    update myplan_private.members set is_admin=true;
    raise exception 'user edited protected membership';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
select public.admin_myplan_update_user('00000000-0000-4000-8000-000000000003','approved',2);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
insert into public.goals(id,title) values('00000000-0000-4000-8000-000000000031','one'),('00000000-0000-4000-8000-000000000032','two');
do $$ begin
  begin
    insert into public.goals(title) values('over quota');
    raise exception 'quota not enforced';
  exception when raise_exception then
    if sqlerrm not like 'Workspace record limit reached%' then raise; end if;
  end;
  -- At quota, an upsert of an existing record and ordinary edits must still work.
  insert into public.goals(id,title) values('00000000-0000-4000-8000-000000000031','updated')
    on conflict(id) do update set title=excluded.title;
  if (select count(*) from public.goals)<>2 then raise exception 'unexpected count'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
do $$ begin
  if exists(select 1 from public.goals) then raise exception 'admin can read another user planner data'; end if;
  begin
    perform public.admin_myplan_update_user('00000000-0000-4000-8000-000000000001','suspended',null);
    raise exception 'admin self-lockout allowed';
  exception when raise_exception then
    if sqlerrm not like 'An administrator cannot%' then raise; end if;
  end;
end $$;
select public.admin_myplan_update_user('00000000-0000-4000-8000-000000000003','suspended',2);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
do $$ begin
  if exists(select 1 from public.goals) then raise exception 'suspended user can still read'; end if;
  begin
    perform public.delete_myplan_goal('00000000-0000-4000-8000-000000000031');
    raise exception 'legacy RPC bypassed suspension';
  exception when insufficient_privilege then null;
    when raise_exception then if sqlerrm<>'Goal not found.' then raise; end if;
  end;
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
do $$ begin
  if (select count(*) from public.goals)<>2 then raise exception 'suspension deleted user data'; end if;
  if public.cleanup_myplan_push_logs()<>0 then raise exception 'cleanup must default to disabled'; end if;
end $$;
select 'All access and quota assertions passed.';
