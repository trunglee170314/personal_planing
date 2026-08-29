#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container=myplan-workspace-test-20260903
if [ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" != none ]; then
  echo 'Refusing non-isolated test database.' >&2
  exit 1
fi
database="workspace_test_$(date +%s)"
docker exec "$container" createdb -U postgres "$database"
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/0019_legacy_time_blocks_delete.sql \
  supabase/migrations/0020_detach_child_goals_on_delete.sql \
  tests/fixtures/access-db-seed.sql supabase/migrations/0021_workspace_access.sql \
  supabase/migrations/0022_push_alarm_scheduler.sql \
  supabase/migrations/0023_workspace_review.sql \
  supabase/migrations/0024_workspace_undo.sql \
  supabase/migrations/0025_planning_commands.sql \
  tests/fixtures/workspace-review-assertions.sql; do
  docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q < "$file"
done
echo 'Workspace migration assertions passed.'
