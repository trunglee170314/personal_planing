#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/.local/state/myplan"
# Capture setup failures too (including missing Node/npm), not only npm output.
exec >> "$HOME/.local/state/myplan/startup.log" 2>&1
printf '\n[%s] START myplan local (PID %s)\n' "$(date -Is)" "$$"
trap 'result=$?; printf "[%s] STOP myplan local (exit code %s)\n" "$(date -Is)" "$result"' EXIT

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
printf '[%s] Project: %s\n' "$(date -Is)" "$project_dir"

if ! command -v npm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "Node.js/npm was not found. Install Node.js 22.13+ inside this WSL distribution." >&2
  exit 127
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "Node.js 22.13+ is required. Current version: $(node --version)." >&2
  exit 1
fi

if [ ! -f node_modules/vinext/package.json ]; then
  echo 'Project dependencies are missing. Run npm ci inside this repository in WSL first.' >&2
  exit 1
fi

printf '[%s] Starting services with Node %s. Wait for the READY line.\n' "$(date -Is)" "$(node --version)"
npm run dev:local
