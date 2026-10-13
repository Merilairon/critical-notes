#!/usr/bin/env bash
# Update the local 5etools clones to the latest upstream commit and re-index.
# The clones are read-only mirrors: local changes in them are discarded.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

SRC="${FIVETOOLS_SRC_PATH:-./5etools-data/5etools-src}"
IMG="${FIVETOOLS_IMG_PATH:-./5etools-data/5etools-img}"

update() {
  local dir="$1"
  if [ ! -d "$dir/.git" ]; then
    echo "✗ $dir is not a git clone; run 'pnpm data:clone' first" >&2
    return 1
  fi
  local branch
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  echo "→ updating $dir ($branch)"
  git -C "$dir" fetch --depth 1 origin "$branch"
  git -C "$dir" reset --hard "origin/$branch"
  echo "  now at $(git -C "$dir" log -1 --format='%h %s')"
}

update "$SRC"
if [ "${SKIP_IMG:-0}" != "1" ] && [ -d "$IMG/.git" ]; then update "$IMG"; fi

if [ "${SKIP_INDEX:-0}" != "1" ]; then
  echo "→ re-indexing"
  pnpm run index
fi
