#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="myplan-scale-benchmark-$(date +%s)-$$"
docker run -d --rm --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
trap 'docker stop "$container" >/dev/null' EXIT
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = none
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/0021_workspace_access.sql \
  supabase/migrations/0022_push_alarm_scheduler.sql \
  supabase/migrations/0023_workspace_review.sql \
  supabase/migrations/0024_workspace_undo.sql \
  supabase/migrations/0025_planning_commands.sql \
  supabase/migrations/0026_timeline_order_colors_and_legacy_delete.sql \
  supabase/migrations/0027_system_maps.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file"
done
# Uses only Node standard modules; no package installation, credentials or cloud calls.
map_scale_node="${MYPLAN_BENCH_NODE:-node}"
"$map_scale_node" scripts/benchmark-system-map-postgres.mjs | docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q -t -A
