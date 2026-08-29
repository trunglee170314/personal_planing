-- Optional content-sized bounds and Keep position for schema-1 maps. Legacy
-- documents and History keep their original 180x64 defaults. No data rewrite.
begin;
create or replace function myplan_private.validate_system_map(doc jsonb) returns void
language plpgsql set search_path='' as $$
declare item jsonb; g jsonb; field text; all_ids text[]:='{}'; pairs text[]:='{}'; pair text; node_ids text[]:='{}'; node_width numeric; node_height numeric;
begin
  if jsonb_typeof(doc) is distinct from 'object' or doc->'schema' is distinct from '1'::jsonb then raise exception 'Unsupported map document.';end if;
  if jsonb_typeof(doc->'name') is distinct from 'string' or length(btrim(doc->>'name'))=0 or length(doc->>'name')>120 or jsonb_typeof(doc->'description') is distinct from 'string' or length(doc->>'description')>4000 then raise exception 'Invalid map name or description.';end if;
  foreach field in array array['nodes','groups','edges'] loop
    if jsonb_typeof(doc->field) is distinct from 'array' then raise exception 'Invalid map entities.';end if;
  end loop;
  if jsonb_array_length(doc->'nodes')>200 or jsonb_array_length(doc->'groups')>40 or jsonb_array_length(doc->'edges')>600 or octet_length(doc::text)>262144 then raise exception 'Map exceeds its size limit.';end if;
  for item in select value from jsonb_array_elements(doc->'groups') union all select value from jsonb_array_elements(doc->'nodes') union all select value from jsonb_array_elements(doc->'edges') loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or (item->>'id')=any(all_ids) then raise exception 'Map IDs must be unique UUIDs.';end if;
    all_ids:=array_append(all_ids,item->>'id');
  end loop;
  for item in select value from jsonb_array_elements(doc->'groups') union all select value from jsonb_array_elements(doc->'nodes') loop
    if jsonb_typeof(item->'name') is distinct from 'string' or length(btrim(item->>'name'))=0 or length(item->>'name')>120 or jsonb_typeof(item->'color') is distinct from 'string' or (item->>'color') !~* '^#[0-9a-f]{6}$' then raise exception 'Invalid node or group appearance.';end if;
    foreach field in array array['x','y'] loop
      if jsonb_typeof(item->field) is distinct from 'number' or abs((item->>field)::numeric)>20000 then raise exception 'Invalid map coordinates.';end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(doc->'groups') loop
    if jsonb_typeof(item->'collapsed') is distinct from 'boolean' or jsonb_typeof(item->'width') is distinct from 'number' or jsonb_typeof(item->'height') is distinct from 'number' then raise exception 'Invalid group dimensions.';end if;
    if (item->>'width')::numeric not between 220 and 8000 or (item->>'height')::numeric not between 130 and 8000 then raise exception 'Invalid group dimensions.';end if;
  end loop;
  for item in select value from jsonb_array_elements(doc->'nodes') loop
    node_ids:=array_append(node_ids,item->>'id');
    if jsonb_typeof(item->'description') is distinct from 'string' or length(item->>'description')>4000 or jsonb_typeof(item->'url') is distinct from 'string' or length(item->>'url')>2000 or not(item?'group_id') then raise exception 'Invalid node details.';end if;
    if (item->>'url')<>'' and (item->>'url') !~* '^https?://[^[:space:]/?#]+[^[:space:]]*$' then raise exception 'Use an http:// or https:// URL.';end if;
    if item?'width' then
      if jsonb_typeof(item->'width') is distinct from 'number' then raise exception 'Node width is invalid.';end if;
      if (item->>'width')::numeric not between 140 and 380 then raise exception 'Node width is invalid.';end if;
    end if;
    if item?'height' then
      if jsonb_typeof(item->'height') is distinct from 'number' then raise exception 'Node height is invalid.';end if;
      if (item->>'height')::numeric not between 64 and 1024 then raise exception 'Node height is invalid.';end if;
    end if;
    if item?'keep_position' and jsonb_typeof(item->'keep_position') is distinct from 'boolean' then raise exception 'Keep position must be a boolean.';end if;
    node_width:=coalesce((item->>'width')::numeric,180);
    node_height:=coalesce((item->>'height')::numeric,64);
    if item->'group_id'<>'null'::jsonb then
      select value into g from jsonb_array_elements(doc->'groups') where value->>'id'=item->>'group_id';
      if not found then raise exception 'Node group does not exist.';end if;
      if (item->>'x')::numeric<(g->>'x')::numeric or (item->>'y')::numeric<(g->>'y')::numeric+44 or (item->>'x')::numeric+node_width>(g->>'x')::numeric+(g->>'width')::numeric or (item->>'y')::numeric+node_height>(g->>'y')::numeric+(g->>'height')::numeric then raise exception 'A group must contain all its nodes.';end if;
    end if;
  end loop;
  for item in select value from jsonb_array_elements(doc->'edges') loop
    if not coalesce((item->>'source')=any(node_ids),false) or not coalesce((item->>'target')=any(node_ids),false) or item->>'source'=item->>'target' or not coalesce((item->>'line') in ('solid','dashed'),false) or not coalesce((item->>'direction') in ('none','forward','both'),false) then raise exception 'Invalid map connection.';end if;
    pair:=least(item->>'source',item->>'target')||':'||greatest(item->>'source',item->>'target');
    if pair=any(pairs) then raise exception 'These nodes are already connected.';end if;
    pairs:=array_append(pairs,pair);
  end loop;
end $$;
revoke all on function myplan_private.validate_system_map(jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
