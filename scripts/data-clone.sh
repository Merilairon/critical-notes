#!/usr/bin/env bash
# Shallow-clone the 5etools data and image repos if they are not present yet.
# Targets FIVETOOLS_SRC_PATH / FIVETOOLS_IMG_PATH (defaults: ./5etools-data/...).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

SRC="${FIVETOOLS_SRC_PATH:-./5etools-data/5etools-src}"
IMG="${FIVETOOLS_IMG_PATH:-./5etools-data/5etools-img}"

clone() {
  local url="$1" dir="$2"
  if [ -d "$dir/.git" ]; then
    echo "✓ $dir already cloned"
  else
    mkdir -p "$(dirname "$dir")"
    echo "→ cloning $url into $dir"
    git clone --depth 1 "$url" "$dir"
  fi
}

clone https://github.com/5etools-mirror-3/5etools-src.git "$SRC"
if [ "${SKIP_IMG:-0}" = "1" ]; then
  echo "↷ skipping images (SKIP_IMG=1)"
else
  echo "Note: 5etools-img is ~13 GB."
  clone https://github.com/5etools-mirror-3/5etools-img.git "$IMG"
fi
