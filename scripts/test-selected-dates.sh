#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="myplan-selected-dates-$(date +%s)-$$"
docker run -d --rm --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
trap 'docker stop "$container" >/dev/null' EXIT
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = none
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/002[1-9]_*.sql supabase/migrations/003[0-2]_*.sql \
  tests/fixtures/selected-dates-assertions.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file"
done
echo 'PostgreSQL selected dates, progress, completion, moves, Undo and ownership passed.'
