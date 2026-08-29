-- Disposable PostgreSQL only; no user records are written.
begin;
do $$
declare doc jsonb; bad jsonb; nodes jsonb; edges jsonb; item jsonb; accepted boolean;
begin
  select jsonb_agg(jsonb_build_object('id',lpad(i::text,8,'0')||'-0000-4000-8000-000000000000',
    'name','Topic '||i,'description','','url','','color','#28745b','x',0,'y',0,'group_id',null))
  into nodes from generate_series(1,1000) i;
  select jsonb_agg(jsonb_build_object('id',lpad((10000+i)::text,8,'0')||'-0000-4000-8000-000000000000',
    'source',nodes->((i-1)/999)->>'id','target',nodes->(1+(i-1)%999)->>'id','line','solid','direction','forward'))
  into edges from generate_series(1,3000) i;
  -- Four independent source rows, excluding self-pairs.
  select jsonb_agg(jsonb_build_object('id',lpad((10000+i)::text,8,'0')||'-0000-4000-8000-000000000000',
    'source',nodes->((i-1)/750)->>'id','target',nodes->(10+(i-1)%750)->>'id','line','solid','direction','forward'))
  into edges from generate_series(1,3000) i;
  doc:=jsonb_build_object('schema',1,'name','Scale validation','description','','groups','[]'::jsonb,'nodes',nodes,'edges',edges);
  perform myplan_private.validate_system_map(doc);
  for item in select value from jsonb_array_elements(jsonb_build_array(
    jsonb_set(doc,'{nodes}',nodes||jsonb_build_array(nodes->0)),
    jsonb_set(doc,'{edges}',edges||jsonb_build_array(edges->0)),
    jsonb_set(doc,'{nodes,1,id}',nodes->0->'id'),
    jsonb_set(doc,'{edges,0,id}',nodes->0->'id'),
    jsonb_set(doc,'{edges,0,source}','null'),
    jsonb_set(doc,'{edges,0,target}','"ffffffff-0000-4000-8000-000000000000"'),
    jsonb_set(doc,'{edges,0,target}',edges->0->'source'),
    jsonb_set(doc,'{nodes,0,group_id}','"ffffffff-0000-4000-8000-000000000000"'),
    jsonb_set(jsonb_set(doc,'{edges,1,source}',edges->0->'target'),'{edges,1,target}',edges->0->'source')
  )) loop
    accepted:=true;
    begin perform myplan_private.validate_system_map(item); exception when others then accepted:=false; end;
    if accepted then raise exception 'Accepted invalid scale document'; end if;
  end loop;
  select jsonb_agg(value||jsonb_build_object('description',repeat('x',4000),'url','https://example.test/'||repeat('x',900))) into nodes from jsonb_array_elements(nodes);
  bad:=jsonb_set(doc,'{nodes}',nodes);
  if octet_length(bad::text)<=4194304 then raise exception 'Oversized fixture is too small'; end if;
  accepted:=true;
  begin perform myplan_private.validate_system_map(bad); exception when others then accepted:=false; end;
  if accepted then raise exception 'Accepted document beyond 4 MiB'; end if;
end $$;
rollback;
