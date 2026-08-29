#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# A fresh, task-owned database with no network, published ports or host mounts.
container="myplan-map-geometry-$(date +%s)-$$"
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
  supabase/migrations/0027_system_maps.sql \
  supabase/migrations/0029_system_map_node_geometry.sql \
  supabase/migrations/0030_system_map_scale.sql \
  tests/fixtures/system-map-geometry-assertions.sql \
  tests/fixtures/system-map-scale-assertions.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file"
done
echo 'PostgreSQL System Map geometry, CAS, History and access assertions passed.'
