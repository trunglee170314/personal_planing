#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container=myplan-workspace-test-20260903
if [ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" != none ]; then
  echo 'Refusing non-isolated test database.' >&2
  exit 1
fi
database="timeline_reorder_test_$(date +%s)"
docker exec "$container" createdb -U postgres "$database"
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/0021_workspace_access.sql \
  supabase/migrations/0022_push_alarm_scheduler.sql \
  supabase/migrations/0023_workspace_review.sql \
  supabase/migrations/0024_workspace_undo.sql \
  supabase/migrations/0025_planning_commands.sql \
  supabase/migrations/0026_timeline_order_colors_and_legacy_delete.sql; do
  docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q < "$file"
done
if [ "${1:-}" = --before-fix ]; then
  if result=$(docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q < tests/fixtures/timeline-reorder-assertions.sql 2>&1); then
    echo 'Expected the pre-fix reorder to fail.' >&2
    exit 1
  fi
  if [[ "$result" != *'column reference "position" is ambiguous'* ]]; then
    echo "$result" >&2
    exit 1
  fi
  echo 'Reproduced the pre-fix PostgreSQL position ambiguity.'
else
  docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q < supabase/migrations/0028_fix_timeline_reorder_position.sql
  docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q < tests/fixtures/timeline-reorder-assertions.sql
  echo 'PostgreSQL Timeline reorder assertions passed.'
fi
