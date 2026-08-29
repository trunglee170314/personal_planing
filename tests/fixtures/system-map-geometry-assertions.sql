-- Disposable PostgreSQL only. Verify both the private validator and public CAS.
begin;
do $$
declare
  legacy jsonb := '{"schema":1,"name":"Geometry","description":"","groups":[{"id":"00000000-0000-4000-8000-000000000010","name":"Group","color":"#28745b","x":0,"y":0,"width":220,"height":130,"collapsed":false}],"nodes":[{"id":"00000000-0000-4000-8000-000000000011","name":"Node","description":"","url":"","color":"#28745b","x":20,"y":60,"group_id":"00000000-0000-4000-8000-000000000010"}],"edges":[]}';
  sized jsonb; bad jsonb; item jsonb; accepted boolean;
begin
  perform myplan_private.validate_system_map(legacy);
  sized := jsonb_set(legacy,'{nodes,0}',legacy#>'{nodes,0}' || '{"width":380,"height":180,"keep_position":true}'::jsonb);
  accepted := true;
  begin perform myplan_private.validate_system_map(sized); exception when others then accepted:=false; end;
  if accepted then raise exception 'Explicit geometry escaped group containment'; end if;
  sized := jsonb_set(jsonb_set(sized,'{groups,0,width}','420'),'{groups,0,height}','270');
  perform myplan_private.validate_system_map(sized);
  for item in select value from jsonb_array_elements('[{"width":null},{"width":"180"},{"width":139},{"width":381},{"height":null},{"height":"64"},{"height":63},{"height":1025},{"keep_position":null},{"keep_position":"true"},{"keep_position":1}]'::jsonb) loop
    bad := jsonb_set(sized,'{nodes,0}',sized#>'{nodes,0}' || item);
    accepted := true;
    begin perform myplan_private.validate_system_map(bad); exception when others then accepted:=false; end;
    if accepted then raise exception 'Accepted malformed geometry: %',item; end if;
  end loop;
  if has_function_privilege('anon','myplan_private.validate_system_map(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','myplan_private.validate_system_map(jsonb)','EXECUTE')
    or has_function_privilege('anon','public.system_map_command(jsonb)','EXECUTE')
    or not has_function_privilege('authenticated','public.system_map_command(jsonb)','EXECUTE')
  then raise exception 'Geometry migration changed RPC access permissions'; end if;
end $$;
insert into auth.users(id,email,email_confirmed_at) values
  ('00000000-0000-4000-8000-000000000099','map@example.test',now()),
  ('00000000-0000-4000-8000-000000000098','other-map@example.test',now());
update myplan_private.members set status='approved',record_limit=1000;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare
  v_map_id uuid := gen_random_uuid();
  legacy jsonb := '{"schema":1,"name":"Geometry CAS","description":"","groups":[],"nodes":[{"id":"00000000-0000-4000-8000-000000000011","name":"Node","description":"","url":"","color":"#28745b","x":20,"y":60,"group_id":null}],"edges":[]}';
  sized jsonb; result jsonb; accepted boolean;
begin
  result:=public.system_map_command(jsonb_build_object('action','create','id',v_map_id,'expected_version',0,'document',legacy));
  sized:=jsonb_set(legacy,'{nodes,0}',legacy#>'{nodes,0}' || '{"width":380,"height":180,"keep_position":true}'::jsonb);
  result:=public.system_map_command(jsonb_build_object('action','save','id',v_map_id,'expected_version',1,'document',sized));
  if result#>'{document,nodes,0,keep_position}' <> 'true'::jsonb then raise exception 'Pin was not persisted'; end if;
  accepted:=true;
  begin perform public.system_map_command(jsonb_build_object('action','save','id',v_map_id,'expected_version',1,'document',legacy)); exception when others then accepted:=false; end;
  if accepted then raise exception 'Stale geometry save was accepted'; end if;
  result:=public.system_map_command(jsonb_build_object('action','restore_revision','id',v_map_id,'expected_version',2,'revision',1));
  if result->'document'<>legacy or result->'version'<>'3'::jsonb then raise exception 'Legacy History restore failed'; end if;
  if (select document from public.system_map_revisions where system_map_revisions.map_id=v_map_id and version=2)<>sized then raise exception 'Sized History was rewritten'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000098',true);
  accepted:=true;
  begin perform public.system_map_command(jsonb_build_object('action','save','id',v_map_id,'expected_version',3,'document',sized)); exception when others then accepted:=false; end;
  if accepted then raise exception 'Another owner edited the map'; end if;
end $$;
rollback;
