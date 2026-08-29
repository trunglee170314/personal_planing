#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Only a fresh, network-isolated disposable PostgreSQL container is touched.
container="myplan-important-milestones-$(date +%s)-$$"
docker run -d --rm --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
trap 'docker stop "$container" >/dev/null' EXIT
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = none
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/002[1-9]_*.sql supabase/migrations/003[01]_*.sql \
  supabase/migrations/0031_important_milestones.sql \
  tests/fixtures/important-milestones-assertions.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file"
done
echo 'PostgreSQL milestone importance, Undo, group moves and owner isolation passed.'
