#!/usr/bin/env bash
# DeerDawn MCP latency benchmark — SAFE by construction.
#
# Times the REST endpoints behind the MCP tools with a full network breakdown
# (DNS / TCP / TLS / server-TTFB / download), cold vs. warm.
#
# SAFETY: every mutating endpoint is exercised via its dry_run / read-only path,
# so running this NEVER writes to the live project brief. Do not add probes that
# POST to /extraction without "dry_run": true — that is what once polluted a
# real brief (a test payload "shape probe" became a project task).
#
# Usage:
#   DEERDAWN_PROJECT_ID=project_xxx scripts/perf/mcp-latency-bench.sh
# Key is read from ~/.deerdawn/credentials.json (or $DEERDAWN_API_KEY).
set -uo pipefail

KEY="${DEERDAWN_API_KEY:-$(python3 -c "import json;print(json.load(open('$HOME/.deerdawn/credentials.json'))['api_key'])")}"
BASE="${DEERDAWN_API_URL:-https://api.deerdawn.com}"
PID="${DEERDAWN_PROJECT_ID:?set DEERDAWN_PROJECT_ID to a project you own}"
N="${BENCH_N:-6}"

FMT='%{time_namelookup} %{time_connect} %{time_appconnect} %{time_pretransfer} %{time_starttransfer} %{time_total} %{http_code} %{size_download}'

time_cold () {
  local method="$1" label="$2" path="$3" body="${4:-}"
  local totals=() servers=() tlss=() code=0 size=0 dns tcp tls pre stt tot
  for i in $(seq 1 "$N"); do
    if [[ "$method" == "GET" ]]; then
      read -r dns tcp tls pre stt tot code size < <(curl -s -o /dev/null -w "$FMT" -H "x-api-key: $KEY" "$BASE$path")
    else
      read -r dns tcp tls pre stt tot code size < <(curl -s -o /dev/null -w "$FMT" \
        -X "$method" -H "x-api-key: $KEY" -H "content-type: application/json" --data "$body" "$BASE$path")
    fi
    local sv; sv=$(awk "BEGIN{printf \"%.4f\", $stt-$tls}")
    totals+=("$tot"); servers+=("$sv"); tlss+=("$tls")
  done
  python3 - "$label" "$code" "$size" "${totals[*]}" "${servers[*]}" "${tlss[*]}" <<'PY'
import sys
label,code,size=sys.argv[1],sys.argv[2],sys.argv[3]
tot=[float(x) for x in sys.argv[4].split()]; srv=[float(x) for x in sys.argv[5].split()]; tls=[float(x) for x in sys.argv[6].split()]
def st(a):
    a=sorted(a); n=len(a); return min(a),(a[n//2] if n%2 else (a[n//2-1]+a[n//2])/2),max(a)
tmn,tmd,tmx=st(tot); _,smd,_=st(srv); _,hmd,_=st(tls)
print(f"{label:38s} code={code} {int(size):>7}B  total(min/med/max)={tmn*1000:6.0f}/{tmd*1000:6.0f}/{tmx*1000:6.0f}ms  handshake={hmd*1000:4.0f}ms  server+net={smd*1000:6.0f}ms")
PY
}

echo "=== DeerDawn MCP latency (N=$N, cold connections — mirrors axios without keep-alive) ==="
echo "-- reads --"
time_cold GET  "get_context (active,no proj)" "/api/v1/context/active?tool=claude_code&verbosity=standard"
time_cold GET  "get_context/inject"           "/api/v1/context/projects/$PID/inject?tool=claude_code&verbosity=standard"
time_cold GET  "get_project_map"              "/api/v1/context/projects/$PID/map?verbosity=standard"
time_cold GET  "list_projects (tree)"         "/api/v1/context/projects/tree"
time_cold GET  "get_workspace_overview"       "/api/v1/context/workspace/overview"
time_cold GET  "get_workspace_entities"       "/api/v1/context/workspace/entities"
time_cold GET  "find_known_paths"             "/api/v1/context/workspace/known-paths?query=context&limit=5"
time_cold GET  "get_next_best_context"        "/api/v1/context/workspace/next?tool=claude_code"
time_cold GET  "list_skills"                  "/api/v1/context/skills"
time_cold POST "search_context"               "/api/v1/context/search" '{"query":"benchmark","limit":5}'
echo "-- write path (dry_run — persists nothing) --"
time_cold POST "update_context (extraction)"  "/api/v1/context/extraction" \
  "{\"session_id\":\"perf-bench\",\"tool\":\"claude_code\",\"project_id\":\"$PID\",\"dry_run\":true,\"chunks\":[{\"role\":\"assistant\",\"text\":\"latency benchmark probe\"}]}"
