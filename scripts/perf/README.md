# DeerDawn MCP latency benchmarking

How to measure MCP tool latency **without mutating live context**.

## The rule

Never point a latency probe at the real `POST /api/v1/context/extraction` write
path. It runs LLM extraction on whatever text you send and persists the result
into the project brief. A one-off `curl` test once turned the payload
`"shape probe"` into a project's `current_task` ("Implement shape probing
functionality"). Benchmarking must be side-effect-free.

## The guard

`POST /extraction` accepts `"dry_run": true`. It runs the full pipeline
(so timing is representative) but **persists nothing** — no delta applied, no
events written, brief untouched. Returns HTTP 200 with `dry_run: true` and the
computed `extraction` delta. Always use it for write-path timing.

Route: `apps/api/src/routes/context/context-sync.js` (`/extraction` handler).

## Run it

```bash
DEERDAWN_PROJECT_ID=project_xxxx scripts/perf/mcp-latency-bench.sh
```

- Key comes from `~/.deerdawn/credentials.json` (or `DEERDAWN_API_KEY`).
- `DEERDAWN_API_URL` defaults to prod; point it at a local API to bench a branch.
- `BENCH_N` controls samples per endpoint (default 6).

Reports per endpoint: total (min/med/max), one-time handshake cost, and
server+network time — cold connections, which mirror how the MCP client's axios
instance behaves without keep-alive.

## For end-to-end (full MCP round-trip incl. the Node handler + file sync)

Drive the built stdio server over JSON-RPC (`node packages/mcp-server/dist/index.js`),
send `initialize` then `tools/call`, and time each response. Use read/orient
tools freely; for `update_context`, pass `dry_run` through or target a scratch
project — never a real one.

## Known latency shape (2026-07)

~85% of tool latency is **server-side compute** on three endpoints
(`/context/active`, `/projects/{id}/map`, `/workspace/next` — ~700ms–1s each,
even warm). The rest is avoidable client tax, addressed on branch
`perf/mcp-latency-quickwins`: HTTP keep-alive, de-duped `start_session` fetch,
and trimming the event log out of the `/extraction` response.
