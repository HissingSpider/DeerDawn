#!/usr/bin/env bash
# Rebuilds the MCP server if source is newer than dist, then launches it.
# Used by .mcp.json so Claude Code always runs the current local build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$PKG_DIR/dist/index.js"
SRC_DIR="$PKG_DIR/src"

needs_rebuild() {
  [[ ! -f "$DIST" ]] && return 0
  # Rebuild if any .ts source file is newer than the dist
  while IFS= read -r -d '' f; do
    [[ "$f" -nt "$DIST" ]] && return 0
  done < <(find "$SRC_DIR" -name "*.ts" -print0)
  return 1
}

if needs_rebuild; then
  echo "[DeerDawn] dist is stale — rebuilding MCP server..." >&2
  (cd "$PKG_DIR" && npm run build) >&2
fi

exec node "$DIST"
