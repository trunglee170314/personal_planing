-- Independent account-owned maps. All writes and history snapshots go through
-- one CAS command; SELECT policies never grant access to another user's maps.
create table public.system_maps (
  id uuid primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  document jsonb not null,
  version bigint not null check(version>0),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index system_maps_owner on public.system_maps(owner_user_id,updated_at desc);
create table public.system_map_revisions (
  map_id uuid not null references public.system_maps(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  version bigint not null,
  document jsonb not null,
  action text not null,
  created_at timestamptz not null default now(),
  changed_by uuid not null references auth.users(id) on delete cascade,
  primary key(map_id,version)
);
alter table public.system_maps enable row level security;
alter table public.system_map_revisions enable row level security;
create policy own_maps on public.system_maps for select to authenticated
  using(owner_user_id=(select auth.uid()) and (select public.myplan_is_approved()));
create policy own_map_history on public.system_map_revisions for select to authenticated
  using(owner_user_id=(select auth.uid()) and (select public.myplan_is_approved()));
revoke all on public.system_maps,public.system_map_revisions from anon,authenticated;
grant select on public.system_maps,public.system_map_revisions to authenticated;

create function myplan_private.validate_system_map(doc jsonb) returns void
language plpgsql set search_path='' as $$
declare item jsonb; g jsonb; field text; all_ids text[]:='{}'; pairs text[]:='{}'; pair text; node_ids text[]:='{}';
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
    if item->'group_id'<>'null'::jsonb then
      select value into g from jsonb_array_elements(doc->'groups') where value->>'id'=item->>'group_id';
      if not found then raise exception 'Node group does not exist.';end if;
      if (item->>'x')::numeric<(g->>'x')::numeric or (item->>'y')::numeric<(g->>'y')::numeric+44 or (item->>'x')::numeric+180>(g->>'x')::numeric+(g->>'width')::numeric or (item->>'y')::numeric+64>(g->>'y')::numeric+(g->>'height')::numeric then raise exception 'A group must contain all its nodes.';end if;
    end if;
  end loop;
  for item in select value from jsonb_array_elements(doc->'edges') loop
    if not coalesce((item->>'source')=any(node_ids),false) or not coalesce((item->>'target')=any(node_ids),false) or item->>'source'=item->>'target' or not coalesce((item->>'line') in ('solid','dashed'),false) or not coalesce((item->>'direction') in ('none','forward','both'),false) then raise exception 'Invalid map connection.';end if;
    pair:=least(item->>'source',item->>'target')||':'||greatest(item->>'source',item->>'target');
    if pair=any(pairs) then raise exception 'These nodes are already connected.';end if;
    pairs:=array_append(pairs,pair);
  end loop;
end $$;

-- Count map entities against the existing logical record limit. Revisions are
-- recovery data and are bounded separately to 50 snapshots per map.
create or replace function myplan_private.record_count(target uuid)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare tab text; owner_col text; total bigint:=0; n bigint;
begin
  foreach tab in array array['goals','tasks','calendar_entries','recurrence_rules','calendar_occurrence_states','timeline_milestones','pomodoro_sessions','reviews','push_subscriptions'] loop
    if to_regclass('public.'||tab) is null then continue;end if;
    owner_col:=case when tab in ('goals','tasks') then 'user_id' else 'owner_user_id' end;
    execute format('select count(*) from public.%I where %I=$1',tab,owner_col) into n using target;total:=total+n;
  end loop;
  select coalesce(sum(1+jsonb_array_length(document->'nodes')+jsonb_array_length(document->'groups')+jsonb_array_length(document->'edges')),0) into n from public.system_maps where owner_user_id=target;
  return total+n;
end $$;
create trigger myplan_map_guard before insert or update or delete on public.system_maps for each row execute function myplan_private.guard_write();
create function myplan_private.enforce_system_map_quota() returns trigger
language plpgsql security definer set search_path='' as $$
declare maximum integer; old_count integer; new_count integer;
begin
  new_count:=1+jsonb_array_length(new.document->'nodes')+jsonb_array_length(new.document->'groups')+jsonb_array_length(new.document->'edges');
  if tg_op='UPDATE' then
    old_count:=1+jsonb_array_length(old.document->'nodes')+jsonb_array_length(old.document->'groups')+jsonb_array_length(old.document->'edges');
    -- Lowering a quota must never trap existing content: edits, reductions,
    -- trash and restore remain possible while new logical entities are blocked.
    if new_count<=old_count then return new;end if;
  end if;
  select record_limit into maximum from myplan_private.members where user_id=new.owner_user_id for update;
  if maximum is not null and myplan_private.record_count(new.owner_user_id)>maximum then raise exception 'Workspace record limit reached.';end if;
  return new;
end $$;
create trigger myplan_map_quota after insert or update on public.system_maps for each row execute function myplan_private.enforce_system_map_quota();

create function public.system_map_list(in_trash boolean default false)
returns table(id uuid,name text,version bigint,updated_at timestamptz,deleted_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.';end if;
  delete from public.system_maps m where m.owner_user_id=auth.uid() and m.deleted_at<now()-interval '30 days';
  return query select m.id,m.name,m.version,m.updated_at,m.deleted_at from public.system_maps m where m.owner_user_id=auth.uid() and (m.deleted_at is not null)=in_trash order by m.updated_at desc,m.id;
end $$;

create function public.system_map_command(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target uuid; expected bigint; action text; doc jsonb; row_map public.system_maps; previous public.system_map_revisions; label text; trashed timestamptz; coalesce_layout boolean:=false;
begin
  if auth.uid() is null or not public.myplan_is_approved() then raise exception 'Approved account required.' using errcode='42501';end if;
  target:=(command->>'id')::uuid;expected:=(command->>'expected_version')::bigint;action:=command->>'action';
  if target is null or expected is null or expected<0 or expected>9007199254740991 then raise exception 'Invalid map command.';end if;
  -- Same owner lock as quota inserts; serialize creation limits as well as CAS.
  perform 1 from myplan_private.members where user_id=auth.uid() for update;
  delete from public.system_maps m where m.owner_user_id=auth.uid() and m.deleted_at<now()-interval '30 days';
  if action='create' then
    if expected<>0 then raise exception 'This map changed in another tab. Reload before editing.';end if;
    if (select count(*) from public.system_maps where owner_user_id=auth.uid())>=50 then raise exception 'Maximum 50 maps. Empty Trash to create another.';end if;
    doc:=command->'document';perform myplan_private.validate_system_map(doc);
    insert into public.system_maps(id,owner_user_id,name,document,version) values(target,auth.uid(),btrim(doc->>'name'),doc,1) returning * into row_map;
  else
    select * into row_map from public.system_maps where id=target and owner_user_id=auth.uid() for update;
    if not found then raise exception 'Map not found.';end if;
    if row_map.version<>expected then raise exception 'This map changed in another tab. Reload before editing.';end if;
    if action='purge' then
      if row_map.deleted_at is null then raise exception 'Move the map to Trash first.';end if;
      delete from public.system_maps where id=target and owner_user_id=auth.uid();return null;
    end if;
    doc:=row_map.document;trashed:=row_map.deleted_at;
    if action='save' then
      if trashed is not null then raise exception 'Restore the map before editing.';end if;
      doc:=command->'document';perform myplan_private.validate_system_map(doc);
    elsif action='trash' then
      if trashed is not null then raise exception 'Map is already in Trash.';end if;trashed:=now();
    elsif action='restore' then
      if trashed is null then raise exception 'Map is not in Trash.';end if;trashed:=null;
    elsif action='restore_revision' then
      if trashed is not null then raise exception 'Restore the map before editing.';end if;
      select document into doc from public.system_map_revisions where map_id=target and owner_user_id=auth.uid() and version=(command->>'revision')::bigint;
      if not found then raise exception 'Revision not found.';end if;perform myplan_private.validate_system_map(doc);
    else raise exception 'Invalid map action.';
    end if;
    update public.system_maps set name=btrim(doc->>'name'),document=doc,version=version+1,updated_at=now(),deleted_at=trashed where id=target and owner_user_id=auth.uid() returning * into row_map;
  end if;
  label:=case when action='save' then coalesce(command->>'label','Edit map') else action end;
  if length(label)>80 then raise exception 'Invalid action label.';end if;
  select * into previous from public.system_map_revisions where map_id=target order by version desc limit 1;
  coalesce_layout:=label='Move layout' and previous.action=label and previous.created_at>now()-interval '5 minutes';
  if coalesce_layout then delete from public.system_map_revisions where map_id=target and version=previous.version;end if;
  insert into public.system_map_revisions(map_id,owner_user_id,version,document,action,created_at,changed_by) values(target,auth.uid(),row_map.version,row_map.document,label,case when coalesce_layout then previous.created_at else now() end,auth.uid());
  delete from public.system_map_revisions where map_id=target and version not in(select version from public.system_map_revisions where map_id=target order by version desc limit 50);
  return to_jsonb(row_map)-'owner_user_id';
end $$;
revoke all on function myplan_private.validate_system_map(jsonb) from public,anon,authenticated;
revoke all on function public.system_map_list(boolean),public.system_map_command(jsonb) from public,anon;
grant execute on function public.system_map_list(boolean),public.system_map_command(jsonb) to authenticated;
notify pgrst,'reload schema';
