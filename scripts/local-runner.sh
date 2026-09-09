#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node "$repository/scripts/local-app.mjs" bundle "$1"
shift
# Keep the native process at Cargo's runner PID so Tauri stops it on rebuild.
exec "$repository/src-tauri/target/local/Patchdeck Local.app/Contents/MacOS/patchdeck" "$@"
