#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="myplan-calendar-today-$(date +%s)-$$"
docker run -d --rm --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
trap 'docker stop "$container" >/dev/null' EXIT
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = none
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for file in tests/fixtures/access-db-setup.sql supabase/bootstrap_current.sql \
  supabase/migrations/002[1-9]_*.sql supabase/migrations/003[0-4]_*.sql \
  tests/fixtures/calendar-series-move-assertions.sql \
  tests/fixtures/calendar-move-outcomes-assertions.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file"
done
printf '%s\n' 'PostgreSQL Calendar/Today series scopes, outcomes, notes, atomicity, Undo and ownership passed.'
