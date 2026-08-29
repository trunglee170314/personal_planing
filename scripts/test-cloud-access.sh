#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container=myplan-access-test-20260902
if [ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" != none ]; then
  echo 'Refusing to seed a database that is not the isolated myplan test container.' >&2
  exit 1
fi
database="myplan_test_$(date +%s)"
docker exec "$container" createdb -U postgres "$database"
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/0019_legacy_time_blocks_delete.sql \
  supabase/migrations/0020_detach_child_goals_on_delete.sql \
  tests/fixtures/access-db-seed.sql supabase/migrations/0021_workspace_access.sql \
  tests/fixtures/access-db-assertions.sql \
  supabase/migrations/0022_push_alarm_scheduler.sql \
  tests/fixtures/push-scheduler-assertions.sql; do
  docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q < "$file"
done

# Two connections competing for the last slot must not exceed the quota.
docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q <<'SQL'
insert into auth.users(id,email,email_confirmed_at)
values('00000000-0000-4000-8000-000000000004','concurrency@example.test',now());
update myplan_private.members set status='approved',record_limit=1
where user_id='00000000-0000-4000-8000-000000000004';
SQL
docker exec "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q -c \
  "begin; insert into public.goals(user_id,title) values('00000000-0000-4000-8000-000000000004','First slot'); select pg_sleep(2); commit;" >/dev/null &
first_writer=$!
sleep 0.3
if second_result=$(docker exec "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q -c \
  "insert into public.goals(user_id,title) values('00000000-0000-4000-8000-000000000004','Competing slot');" 2>&1); then
  wait "$first_writer"
  echo 'Concurrent inserts bypassed the quota.' >&2
  exit 1
fi
wait "$first_writer"
if [[ "$second_result" != *"Workspace record limit reached"* ]]; then
  echo "$second_result" >&2
  exit 1
fi
echo 'Concurrent quota assertion passed.'
