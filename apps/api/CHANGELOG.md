# Changelog — DeerDawn Session Memory API

All notable, contract-affecting changes to the context-sync (session-memory) API.
This API is **additive-only**: published shapes, route paths, and MCP tool names
are a contract and are never renamed or removed.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Brief spine, Phase B (MCP / API surface)

### Added

- **`landmines[]` brief field** — a new optional, defaulted slot on the context
  object holding sharp, durable watch-outs (footguns, fragile invariants). Object
  entries (not bare strings) carry per-item provenance so trust can be derived.
  - Writable via `PATCH /api/v1/context/:projectId/context` (added to the patchable
    whitelist) and on `POST /api/v1/context/projects` (added to the create schema).
  - `resolved_landmines[]` is accepted on PATCH as a removal directive — it filters
    matching landmines by a phrase from their summary and is not itself stored.
- **`shipped[]` brief field** — a deterministic completion accumulator populated
  from structured `task_completed` / `feature_shipped` events (never LLM-guessed).
  Readable as a brief section; patchable for explicit/manual writes.
- **`?shape=spine` brief payload** — opt-in query param on `GET /api/v1/context/active`
  and `GET /api/v1/context/projects/:id/inject`. When set, the brief **TEXT body** is
  rendered as the four labeled slots **SHIPPED / DECIDED / OPEN / LANDMINE**
  (omit-not-fabricate: empty slots are skipped). `?format=brief` is an accepted alias.
  - **Default (no param) is unchanged** — the on-the-wire injection text and the
    SessionStart hook keep their current shape. This param is purely additive.
- **Structured `brief_spine`** — the 4-slot brief is attached to the injection
  payload (and to the `GET /active` response) **regardless of the text shape**. Each
  item carries a derived **trust band**: `high` (verified or confidence ≥ 0.75),
  `inferred` (0.4–0.75, or date-inferred / inferred source), or `unverified`.
  Trust is derived, never stored — one vocabulary across every brief surface.
- **`landmines` / `shipped` sections** — accepted by section-targeted reads
  (`get_context` / `read_brief` with `sections=[...]`, and the `sections=` query
  param on `/active` and `/inject`).
- **OpenAPI registration** — the session-memory routes (`GET /active`,
  `GET /projects/:id/inject`, `GET`/`POST /projects`, `POST /extraction`,
  `GET /export`, `POST /match`, `GET`/`PATCH /preferences`) are now in the spec,
  with a typed `BriefPayloadSchema` (the 4 slots + per-item trust + the existing
  body/provenance).
- **MCP tool aliases** — product-voice aliases added to the local MCP server:
  - `read_brief` — "Read your project brief — what you shipped, decided, what's
    open, and the landmines — the same brief your AI reads at session start."
    Delegates to the `get_context` read path; default view is the 4-slot brief.
  - `update_brief` — "Update your brief — record a decision, an open question, a
    landmine, or shipped work." Delegates to the `update_context` write path.

### Deprecation policy (important)

- The MCP tool names **`start_session`**, **`get_context`**, and **`update_context`**
  are a **published contract** (baked into shipped CLAUDE.md / AGENTS.md /
  `.cursorrules` and the SessionStart hook). They are **permanent and will never be
  renamed or removed**. The new `read_brief` / `update_brief` names are *aliases*
  that sit alongside them — adopting the product-voice names does not retire the old
  ones. `start_session` in particular is never renamed.
