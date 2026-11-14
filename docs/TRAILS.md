# Trails (`.dawn`)

A **Trail** is a portable archive of one project's accumulated memory: the brief
spine, the decisions and why they were made, the knowledge graph, hot paths,
debugging findings, commands, and the board.

Two things a Trail is deliberately not:

- **Not encrypted or obfuscated.** A `.dawn` file is plain UTF-8 JSON. Open it in
  an editor, diff two of them in git, reimplement the reader in an afternoon. If
  the format's value depended on being hard to read, an OSS audience would find
  out immediately and that would define the project's reputation.
- **Not public by default.** Export produces a private, *unscanned* file.
  Publishing is a separate, gated flow. There is no API route, MCP action, or CLI
  flag that exports and publishes in one step.

---

## Format

```
{
  "format": "dawn",
  "format_version": 1,
  "manifest": { kind, … },
  "content": { brief, decisions, graph, paths, findings, commands, board },
  "checksum": { "algorithm": "sha256", "canonicalization": "sorted-key-json-v1", "value": "…" }
}
```

**Kind.** `manifest.kind` is `project` or `pack`. A *project* Trail is one
project's memory — moved between machines, or published as a case study. A *pack*
is curated knowledge about a stack or a tool, written to be imported into
projects it was never part of. The distinction lives in the manifest rather than
in a convention because the importer acts on it (see Importing). A Trail with no
`kind` reads as `project`, which is what every Trail exported before the field
existed is; an *unrecognized* kind is refused at parse time rather than defaulted,
for the same reason a future `format_version` is.

Export with `?kind=pack`, or `manage_memory(action:"export_trail", kind:"pack")`.

**Checksum.** SHA-256 over the canonical JSON encoding of
`{format, format_version, manifest, content}`. Canonical means: object keys
sorted by code unit, no insignificant whitespace, `undefined` keys omitted,
array order preserved. The `checksum` block itself is not part of the digest
input. Any third-party reader can verify a Trail without our code.

**Source pin.** `manifest.source` records the repo URL, full commit SHA, and
branch the Trail was exported from. A Trail without a valid pin is marked
`pinned: false` with an `unpinned_reason` rather than being quietly presented as
current — a confidently wrong map costs more than no map.

**Provenance.** `manifest.provenance` carries `trail_id`, `author`,
`forked_from`, and an oldest-first `lineage` array, so attribution survives
re-export when forking lands (P1).

**Owner data never travels.** `owner_key`, `owner_user_id`, `linked_paths`,
`linked_conversations`, `tool_presence`, and session telemetry are dropped at
export time rather than filtered downstream. Brief fields are enumerated in
`trailExport.js` rather than spread, so a new context field added upstream is
opt-in to publication, never opt-out.

---

## Publishing: the redaction gate

The thing being published is a dump of private project memory assembled over
months by an agent that was never told it would become public. A one-click
"publish my project" would leak credentials, home paths, client names, and
financial figures on first use, permanently — mirrors, caches, and scrapers do
not honor an unpublish.

The gate enforces four properties in code, not in the UI:

| Property | Enforcement |
|---|---|
| Nothing publishes unscanned | `finalizePublish` re-runs the scanner server-side on the exact bytes about to ship. A client-supplied scan is advisory only. |
| Every finding resolved individually | `decisions` is keyed by finding id. A submission missing one id is rejected with the list. |
| No publish-all | Wildcard keys (`*`, `all`, `approve_all`, …) are rejected by name, and keeping a high-severity finding costs a written per-finding justification. Bulk-approving is *more* work than reviewing. |
| Decisions bound to content | Each decision carries the finding's digest. Edit the field and the old approval stops counting. |

Detected categories: credentials (delegated to `utils/secretRedaction`, so the
scanner can never be weaker than the storage redactor), emails, absolute home
paths, account/card numbers, financial figures, and personal names.

**Scanner bias is inverted on purpose.** `utils/secretRedaction.js` is documented
as biased toward false negatives — mangling someone's debugging notes on the way
into storage is worse than missing a low-entropy placeholder. On the way *out*
to a public gallery that trade reverses: a false positive costs one click, a
false negative is permanent. When the scanner is too noisy, the fix is a better
scanner, never a bypass.

**Person-name detection** works two ways. Seeded names (the account holder,
names harvested from the owner's other project titles) are high-confidence and
carry the weight. A capitalized-bigram heuristic runs alongside at low
confidence and is expected to be noisy; it exists so a human glances at it.

### Flow

```
GET  /api/v1/context/projects/:id/trail            → private .dawn (unscanned)
GET  /api/v1/context/projects/:id/trail/preview    → findings, grouped by field
POST /api/v1/context/projects/:id/trail/publish    → { decisions: { <findingId>: { action, justification? } } }
POST /api/v1/context/trail/import                  → merge a .dawn in
```

A blocked publish returns **422** (the request is well-formed; the *content* is
not publishable) with the unresolved findings attached.

### Unpublishing

`trailPublish.unpublish(trail, { reason })` flips `manifest.published.state` to
`unpublished`, stamps `unpublished_at`, and re-seals the checksum. The Trail
leaves the gallery and its URL stops resolving.

**It is not an undo, and the API says so in the response:**

> Unpublished: the Trail is removed from the gallery and its URL stops resolving.
> It does not recall copies already downloaded, forked, cached, or indexed. Treat
> anything that was public as permanently public.

That wording is deliberate. An author who believes unpublish is an undo will
publish more carelessly, which makes the gate weaker in exactly the place it
matters. If a credential was published, the response is to rotate it — not to
unpublish and assume it is contained.

---

## Importing

The one rule: **an import must never destroy what the target project already
knows.** Someone pulling a community Trail into a project they have built over
months is adding a perspective, not handing their memory to a stranger. If
import can clobber, nobody imports twice.

- Scalar brief fields are **fill-only**. An existing non-empty value always wins;
  the incoming value is reported as a conflict, never silently applied.
- List fields are **unioned in the import planner**, not delegated.
  `mergeContextObject` *replaces* `goals`/`tech_stack`/`recurring_context`/
  `file_structure_summary` when a delta carries them — correct for an extraction
  that just observed the whole project, wrong for a foreign Trail. Passing a
  precomputed union makes the replace a no-op.
- Commands: a local label wins a collision, and the difference is reported.
- Board: cards arrive only when the title is new, and a card that was `done` in
  the source lands in `backlog` — someone else's finished work is not yours.
- Graph nodes go through the normal entity upsert, which dedupes on canonical
  key, so importing twice converges instead of doubling.

**A pack takes even less.** Fill-only makes a foreign Trail safe for an
established project, but not for an *empty* one: a fresh project importing a pack
would adopt the pack author's `current_task`, `next_action` and `goals` as its
own, and the next brief would report somebody else's work as yours. So a pack
donates only `tech_stack`, `recurring_context` and `landmines` from the brief —
an allow-list, so a field added upstream is opted *in* to a stranger's project
rather than out — and no board cards at all, since a board is the one section
where noise is unmissable. Everything worth having still travels: decisions, hot
paths, findings, commands, and the graph. What was withheld is reported in
`summary.skipped_brief_fields` rather than dropped in silence, because silence is
indistinguishable from the pack having had nothing to say.

**Importing by URL.** `manage_memory(action:"import_trail", trail:"https://…")`
accepts a link, because packs are distributed as links and "download it, find
where it saved, pass the path" is three steps an agent gets wrong in front of a
first-time user. Who does the fetching differs by surface, and the difference is
the point:

| Surface | Fetches | Allowed origins |
|---|---|---|
| Local stdio (`@deerdawn/mcp-server`) | the runtime, on the user's machine | any https host (loopback http for local testing) |
| Hosted connector + `POST /trail/import` | the API | `TRAIL_FETCH_ORIGINS`, default the marketing site |

The asymmetry is about whose network is doing the fetching, not who is asking. A
server that fetches caller-supplied URLs is an SSRF primitive aimed at its own
VPC, so server-side the origin must match one we serve Trails from *exactly* and
redirects are refused rather than followed — a 302 off an allowed origin is the
obvious way around an origin check. On the user's own machine there is no
internal network to reach, so the host can be anything.

Both paths cap at 5MB and 15s. None of that establishes the bytes are
trustworthy; it bounds what they can cost. The checksum verify and the
non-destructive merge are what make pulling a stranger's Trail safe.

> **Landmine.** `trailImport.js` mirrors `normalizeKey`/`canonicalWorkspaceKey`
> from `contextSyncService.js` byte-for-byte. `upsertWorkspaceEntities` resolves
> relation endpoints by canonical key and *silently skips* an edge when either
> endpoint misses (`if (!fromNode || !toNode) continue;`). Any drift therefore
> produces an import that reports success while discarding the entire graph
> structure — no error, no warning. `trail-import.test.js` extracts both
> functions from the service source and asserts they agree; it has already caught
> one drift during development.

---

## Is this actually worth a format?

The bet is that a Trail earns its complexity by being *queryable*. That claim is
tested rather than asserted: `trailFlatten.js` renders a Trail to markdown in
good faith (every field, every edge spelled out as a sentence, reasoning
included), and `trailProbe.js` runs the same realistic consumer questions
against both forms.

Three rules keep the comparison from being rigged, since a probe suite is
trivially riggable — pick six traversal questions and prose "loses" 6–0 while
proving nothing:

1. **Balance.** The set is weighted toward what prose is good at: six lookup
   probes against six traversal probes. Scores are reported per-kind as well as
   blended, because the blend hides the only interesting finding.
2. **Best-effort prose.** Each prose strategy is the best a competent
   grep-driven agent would do, including reading a whole section when that is
   the right move. Where prose can answer by paying more, it is scored *correct*
   and charged the bytes — never marked wrong.
3. **Realistic noise.** The fixture contains notes whose bodies mention service
   names, because real project memory does. Testing grep on a corpus with no
   near-misses would flatter it.

19 probes across six question kinds, measured 2026-08-17 at 18 / 22 / 26 graph
nodes:

| | small | medium | large |
|---|---|---|---|
| Graph answers | 19/19 | 19/19 | 19/19 |
| **Prose answers** | **19/19 (100%)** | **19/19 (100%)** | **19/19 (100%)** |
| Prose retrieval cost | 4.97× | 5.44× | 5.93× |

Per question kind, at the large scale:

| Kind | Prose correct | Prose cost |
|---|---|---|
| lookup (6 probes) | 6/6 | **1.10×** — a tie |
| traverse (6) | 6/6 | 2.98× |
| negation (1) | 1/1 | 9.33× |
| filter (4) | 4/4 | 9.54× |
| aggregate (2) | 2/2 | **71.82×** |

### Read this honestly

**Flat markdown answers every question the graph does.** There is no
answerability advantage. The entire case for the format is *retrieval cost* —
what it takes to get the answer into a context window.

An earlier, narrower version of this harness reported prose at 83% and we nearly
shipped that claim. It was wrong, and the way it was wrong is instructive: two
prose strategies were under-powered (the two-hop reader couldn't parse a
relationship line it should have handled) and a section reader matched only
`###`, so it silently fell back to scanning the whole document and mis-scored a
question prose answers correctly. A probe suite scores the *implementation* of a
strategy, not that strategy's ceiling — a weak grep reader looks exactly like
proof that grep can't do something.

So, precisely:

- **Do not claim markdown can't traverse.** It can — one grep per hop, following
  names. It is a toll, not a wall, and the toll compounds with depth.
- **Do not pitch lookup.** At 1.10× it is a tie, and on several single-fact
  probes prose is outright *cheaper* than the graph.
- **Do pitch aggregation, filtering, and absence.** "How many of each type?",
  "which are degraded?", "which decisions are still live?", "what's
  disconnected?" — these cost 9–72× more in prose, because the answer is defined
  by a property spread across the whole document rather than written in one
  place. Absence is the extreme case: there is nothing to grep for, so the only
  correct strategy is to read everything and filter.
- **The gap widens with size** (4.97× → 5.93× overall, aggregate 53.8× → 71.8×),
  which is the case that matters for months-old context.

`tests/unit/trail-graph-native.test.js` fails if the cost ratio ever drops below
3× — at which point the honest response is to ship markdown.

**Caveats.** The fixture is synthetic. The traverse cost ratio is flat across
scales (2.98×) because the fixture's graph diameter is fixed while filler grows —
a deeper graph would likely widen it, and that is untested. The prose strategies
are charged a whole-document read when that is genuinely the best approach,
which is what produces 100% answerability alongside a large cost gap; a reader
with unlimited context and unlimited patience really can answer everything from
the markdown.

---

## Files

| Path | Role |
|---|---|
| `apps/api/src/services/trail/trailFormat.js` | bytes, canonicalization, checksum, parse (pure) |
| `apps/api/src/services/trail/trailExport.js` | project → Trail (pure) |
| `apps/api/src/services/trail/trailScan.js` | finds what must not be published (pure) |
| `apps/api/src/services/trail/trailPublish.js` | the gate (pure) |
| `apps/api/src/services/trail/trailImport.js` | Trail → merge plan (pure) |
| `apps/api/src/services/trail/trailFetch.js` | resolving a Trail URL against the origin allow-list |
| `apps/api/src/services/trail/trailFlatten.js` | good-faith markdown renderer (pure) |
| `apps/api/src/services/trail/trailProbe.js` | graph-vs-prose measurement (pure) |
| `apps/api/src/services/trail/index.js` | facade — the only module that touches the DB |
| `packages/mcp-server/src/freshness.ts` | `getSourcePin` — repo/commit/branch/dirty |

MCP surface: `manage_memory(action: "export_trail" | "import_trail")`, with
`kind` on export and a URL, path, or raw contents accepted by `trail` on import.
No new tool names — the tool surface is a published contract, so Trails ride on
the existing verb.
