-- One-time rollout snapshot, not a replacement for off-site pg_dump backups.
-- Contains private planner data: SQL operator access only, never commit exports.
begin isolation level repeatable read;
create schema myplan_rollout_backup_20260902;
revoke all on schema myplan_rollout_backup_20260902 from public,anon,authenticated,service_role;
create table myplan_rollout_backup_20260902.snapshot (
  captured_at timestamptz not null default now(),
  data jsonb not null,
  metadata jsonb not null
);
do $$
declare target_table record; rows jsonb; contents jsonb:='{}'; meta jsonb;
begin
  for target_table in select tablename from pg_tables where schemaname='public' order by tablename loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r)),''[]''::jsonb) from public.%I r',target_table.tablename) into rows;
    contents:=contents||jsonb_build_object(target_table.tablename,rows);
  end loop;
  meta:=jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
    'policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='public'),
    'triggers',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'definition',pg_get_triggerdef(t.oid)))
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where not t.tgisinternal and n.nspname in ('public','auth')),
    'table_grants',(select jsonb_agg(to_jsonb(g)) from information_schema.role_table_grants g where table_schema='public'),
    'columns',(select jsonb_agg(to_jsonb(c)) from information_schema.columns c where table_schema='public'),
    'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',co.conname,'definition',pg_get_constraintdef(co.oid)))
      from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'indexes',(select jsonb_agg(to_jsonb(i)) from pg_indexes i where schemaname='public')
  );
  insert into myplan_rollout_backup_20260902.snapshot(data,metadata) values(contents,meta);
end $$;
revoke all on all tables in schema myplan_rollout_backup_20260902 from public,anon,authenticated,service_role;
alter table myplan_rollout_backup_20260902.snapshot enable row level security;
commit;
select captured_at,(select count(*) from jsonb_object_keys(data)) as tables_saved
from myplan_rollout_backup_20260902.snapshot;
