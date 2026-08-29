import { readFileSync } from 'node:fs';
import { scaleMap } from '../tests/fixtures/system-map-scale.mjs';
// SQL emitted only to the isolated container launched by the companion script.
const validator =
  process.env.MYPLAN_BENCHMARK_VALIDATOR === 'legacy' ? '0029' : '0030';
const migration = readFileSync(
  new URL(
    `../supabase/migrations/${validator === '0029' ? '0029_system_map_node_geometry.sql' : '0030_system_map_scale.sql'}`,
    import.meta.url,
  ),
  'utf8',
);
if (validator === '0029')
  for (const needle of [
    "jsonb_array_length(doc->'nodes')>200",
    "jsonb_array_length(doc->'edges')>600",
    'octet_length(doc::text)>262144',
  ])
    if (!migration.includes(needle))
      throw new Error(
        'Validator contract changed; review the benchmark override.',
      );
console.log(
  validator === '0030'
    ? migration
    : migration
        .replace(
          "jsonb_array_length(doc->'nodes')>200",
          "jsonb_array_length(doc->'nodes')>1000",
        )
        .replace(
          "jsonb_array_length(doc->'edges')>600",
          "jsonb_array_length(doc->'edges')>3000",
        )
        .replace(
          'octet_length(doc::text)>262144',
          'octet_length(doc::text)>4194304',
        ),
);
console.log(`insert into auth.users(id,email,email_confirmed_at) values ('00000000-0000-4000-8000-000000000099','scale@example.test',now());
update myplan_private.members set status='approved',record_limit=100000;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',false);
select set_config('request.jwt.claim.role','authenticated',false);
create temporary table scale_timings(nodes integer,operation text,ms double precision);
`);
for (const count of [200, 500, 1000]) {
  const doc = JSON.stringify(scaleMap(count)).replace(/'/g, "''");
  console.log(`do $bench$
declare d jsonb:='${doc}'::jsonb; m uuid:=gen_random_uuid(); r jsonb; version_num bigint:=1; started timestamptz;
begin
  r:=public.system_map_command(jsonb_build_object('id',m,'action','create','expected_version',0,'document',d));
  for sample in 1..12 loop
    started:=clock_timestamp();perform myplan_private.validate_system_map(d);
    insert into scale_timings values (${count},'validate',extract(epoch from clock_timestamp()-started)*1000);
    started:=clock_timestamp();r:=public.system_map_command(jsonb_build_object('id',m,'action','save','expected_version',version_num,'document',d,'label','Edit map'));version_num:=version_num+1;
    insert into scale_timings values (${count},'save RPC',extract(epoch from clock_timestamp()-started)*1000);
  end loop;
  started:=clock_timestamp();r:=public.system_map_command(jsonb_build_object('id',m,'action','restore_revision','expected_version',version_num,'revision',1));version_num:=version_num+1;
  insert into scale_timings values (${count},'restore RPC',extract(epoch from clock_timestamp()-started)*1000);
  if r->'document'<>d then raise exception 'Restored snapshot differs';end if;
  for sample in 1..55 loop
    r:=public.system_map_command(jsonb_build_object('id',m,'action','save','expected_version',version_num,'document',d,'label','Edit map'));version_num:=version_num+1;
  end loop;
  if (select count(*) from public.system_map_revisions where map_id=m)<>50 then raise exception 'History retention failed';end if;
end $bench$;`);
}
console.log(
  `select 'MYPLAN_SCALE_POSTGRES '||json_build_object('timings',(select json_agg(t) from (select nodes,operation,round(percentile_cont(.5) within group(order by ms)::numeric,2) as p50_ms,round(percentile_cont(.95) within group(order by ms)::numeric,2) as p95_ms from scale_timings group by nodes,operation order by nodes,operation) t),'history',(select json_agg(t) from (select jsonb_array_length(m.document->'nodes') as nodes,count(*) as snapshots,sum(pg_column_size(r.document)) as compressed_snapshot_bytes from public.system_maps m join public.system_map_revisions r on r.map_id=m.id group by m.id order by nodes) t));`,
);
