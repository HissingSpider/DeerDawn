import type { DeerdawnClient } from './client.js';

// ─── Project references arrive as NAMES ──────────────────────────────────────
//
// Every schema on this surface wants `project_id`, and the model almost never
// holds one. Names are what it holds: the brief prints a name, the task board
// prints a name, `recall({ action: "projects" })` prints a name with the id in
// parentheses — the id appears in exactly one place and is a UUID nobody carries
// between turns. So the most common call the model can make is the one that
// fails, and the failure is silent-ish: a name lands as an id, the API 404s, and
// the agent is told "Resource not found" about a project it can see.
//
// The fix is not a better error. It is accepting the value the caller actually
// has. This module resolves a name to an id ONCE, centrally, at the dispatcher —
// `handleToolCall` in tools/index.ts — so every tool on the surface gains it and
// no tool has to remember. Adding a tool with a project_id parameter requires no
// work here.
//
// Three rules shape the implementation:
//
//   1. An id costs nothing. Values that already look like ids are recognised by
//      prefix and short-circuit before any network call, so the common path is
//      byte-identical to what it was. The list request happens only when a name
//      is actually present.
//
//   2. Matching is EXACT, never partial. `normalizeProjectName` mirrors the
//      server's own duplicate-name gate in contextSyncService.normalizeName, so
//      this resolves to precisely the project the server already considers "the
//      same name" — "DeerDawn API", "deerdawn-api" and "deerdawn api" are one
//      project, while "api" is not a match for "API Gateway". Containment
//      matching was rejected deliberately: it turns a typo into a confident
//      write to the wrong project.
//
//   3. Ambiguity REFUSES. Resolving two candidates by picking one writes a
//      user's memory into someone else's project, and nothing inside the tool
//      can undo that. Two matches means the call stops, with the candidates
//      listed, before the handler runs at all.
//
// A name with no match is left alone and passed through untouched, so the
// existing behaviour (and handleApiError's field-level hint) is unchanged.

/**
 * Argument keys that hold a REFERENCE to an existing project.
 *
 * `project_name` and `new_project_name` are deliberately absent: those are
 * labels being written, not references being read, and rewriting them into ids
 * would rename projects to UUIDs.
 */
const PROJECT_REF_KEYS = new Set(['project_id', 'parent_project_id', 'related_project_id']);

/** Deep enough for `upsert_workspace_entities`' entities[].project_id; bounded so
 *  a hostile or huge payload cannot turn argument rewriting into a hot loop. */
// How many archived projects to pull when resolving a name against them.
// The endpoint's own default is 10, sized for start_session's display notice.
// Resolution needs to see EVERY row it could match — a candidate it cannot see
// is an ambiguity it cannot detect — so it asks for the server's maximum. If a
// full page still comes back, resolution refuses rather than guessing.
const ARCHIVED_SCAN_LIMIT = 500;
const MAX_DEPTH = 6;
const MAX_NODES = 4000;

/**
 * Ids are `project_<uuid>` (contextSyncService.makeId). Matched by PREFIX rather
 * than by full UUID shape on purpose: the prefix is the part that is guaranteed,
 * and a stricter pattern would send legacy or seeded ids on a pointless name
 * lookup. A project literally named "project_…" is the one thing this cannot
 * resolve, which is a trade worth making for a zero-cost fast path.
 */
export function looksLikeProjectId(value: string): boolean {
  return value.startsWith('project_');
}

/**
 * Mirrors contextSyncService.normalizeName — the server's own name identity.
 *
 * This was a copy of the rule the server has since replaced: keep [a-z0-9] and
 * nothing else. It did two wrong things, and here they are worse than on the
 * server, because this function decides which project a WRITE is rewritten to:
 *
 *   - `C#`, `C++` and `C` all became "c". A reference to "Parser C++" matched
 *     "Parser C#" and "Parser C" as well, so with more than one of them on the
 *     account every reference to any of them was refused as ambiguous and none
 *     could be named.
 *   - a name with no Latin letter at all ("支付网关", "Платёжный шлюз") became
 *     ''. The loop below skips an empty target, so such a project could not be
 *     referred to by name at all; the name went to the API as an id and 404'd.
 *
 * So, exactly as the server now does it: any letter or digit in any script
 * survives (\p{L}\p{N}, plus \p{M} — in Devanagari, Thai and others the vowel
 * signs ARE combining marks, and dropping them merges different words). NFKC
 * first, so a composed "ё" and a decomposed one compare equal. `#` and `+`
 * survive only when they are ATTACHED to the word before them, which is when
 * they are part of the name ("C#", "C++", "Notepad++"); free-standing, as in
 * "Node + React" or "Issue #42", they are punctuation, as they always were.
 *
 * The two implementations cannot share a module (the API is CommonJS behind a
 * service that needs a database to load), so tests/project-name-identity.test.ts
 * pins this one to the server's published cases.
 */
export function normalizeProjectName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<![\p{L}\p{N}#+])[#+]+/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}#+]/gu, '');
}

/**
 * The rule every project was matched with before the one above. Kept ONLY as a
 * fallback tier for resolving a caller's reference: somebody who has always
 * typed "roadmap c" to reach "Roadmap C#" must still reach it. Never the first
 * answer, and never used to decide that two names are the same project — that
 * merge is what the rule was replaced to stop.
 */
export function legacyNormalizeProjectName(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Did the old rule read this reference IN FULL?
 *
 * Given "支付 Gateway" it kept "gateway" and threw the rest away, so falling back
 * to it would resolve a name nobody has to the project called "Gateway". The
 * fallback exists for spellings the old rule understood, not for the fragments
 * it happened to leave behind. Same test as the server's.
 */
function legacyRuleReadAllOfIt(value: unknown): boolean {
  return !/[^\p{ASCII}]/u.test(String(value ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, ''));
}

interface ProjectRow {
  project_id?: string;
  project_name?: string;
  aliases?: string[];
  subprojects?: ProjectRow[];
}

export interface ResolveOutcome {
  /** Arguments with every resolvable name replaced by its id. */
  args: any;
  /** Set when a name matched more than one project — the call must not proceed. */
  refusal?: string;
}

function collectNames(node: unknown, depth: number, out: Set<string>, budget: { left: number }): void {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH || budget.left <= 0) return;
  budget.left -= 1;

  if (Array.isArray(node)) {
    for (const item of node) collectNames(item, depth + 1, out, budget);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (!PROJECT_REF_KEYS.has(key)) continue;
      const raw = value.trim();
      if (raw && !looksLikeProjectId(raw)) out.add(raw);
      continue;
    }
    collectNames(value, depth + 1, out, budget);
  }
}

/**
 * Rebuilds only the containers that actually changed, so an argument object with
 * no names in it comes back by reference — identity is the cheapest possible
 * proof that the fast path did nothing.
 */
function rewriteNames(node: any, resolved: Map<string, string>, depth: number): any {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return node;

  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const mapped = rewriteNames(item, resolved, depth + 1);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : node;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string' && PROJECT_REF_KEYS.has(key)) {
      const id = resolved.get(value.trim());
      if (id && id !== value) {
        next[key] = id;
        changed = true;
      } else {
        next[key] = value;
      }
      continue;
    }
    const mapped = rewriteNames(value, resolved, depth + 1);
    if (mapped !== value) changed = true;
    next[key] = mapped;
  }
  return changed ? next : node;
}

function flattenRows(rows: unknown, out: ProjectRow[] = []): ProjectRow[] {
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    out.push(row as ProjectRow);
    flattenRows((row as ProjectRow).subprojects, out);
  }
  return out;
}

/**
 * Candidates for one normalized name, best tier first.
 *
 * An exact `project_name` match outranks an alias match: a real name beats a
 * nickname, so a project renamed to "Billing" is not made ambiguous by some
 * other project still carrying "billing" as an old alias. Only ties WITHIN the
 * winning tier are ambiguous.
 */
type NameRule = 'current' | 'legacy';

function candidatesFor(reference: string, rows: ProjectRow[], rule: NameRule = 'current'): ProjectRow[] {
  // The old rule answers only for a reference it read in full — see above.
  if (rule === 'legacy' && !legacyRuleReadAllOfIt(reference)) return [];
  const normalize = rule === 'legacy' ? legacyNormalizeProjectName : normalizeProjectName;
  const wanted = normalize(reference);
  if (!wanted) return [];
  const byName: ProjectRow[] = [];
  const byAlias: ProjectRow[] = [];
  for (const row of rows) {
    if (!row?.project_id) continue;
    if (normalize(row.project_name) === wanted) {
      byName.push(row);
      continue;
    }
    if ((row.aliases || []).some((alias) => normalize(alias) === wanted)) byAlias.push(row);
  }
  const tier = byName.length ? byName : byAlias;
  // A project can legitimately appear twice (flat list plus a nested tree); the
  // same id twice is one candidate, not an ambiguity.
  return [...new Map(tier.map((row) => [row.project_id as string, row])).values()];
}

/**
 * The projects the server would call THE SAME NAME as `name` — current rule
 * only, names only. For callers about to CREATE a project (the local import),
 * where the question is "would the server's duplicate gate refuse this?", not
 * "what might this reference have meant": the legacy tier never decides that two
 * names are one project, and neither does an alias.
 */
export function projectsNamedLike(name: unknown, rows: unknown): ProjectRow[] {
  const wanted = normalizeProjectName(name);
  if (!wanted) return [];
  const named = flattenRows(rows).filter((row) => row?.project_id && normalizeProjectName(row.project_name) === wanted);
  return [...new Map(named.map((row) => [row.project_id as string, row])).values()];
}

// A single match found in a TRUNCATED archive is not a unique match — there may
// be another row with the same name just past the page boundary. Refusing here
// costs the user one extra step; guessing costs them a write filed into the
// wrong project's memory, which nothing in this tool can undo.
function truncatedArchiveRefusal(name: string, candidate: ProjectRow): string {
  return [
    `"${name}" matched an archived project, but there are more archived projects than`,
    'this lookup can see, so the match cannot be proven unique and nothing was written or read.',
    '',
    `  • ${candidate.project_name || '(unnamed)'} — ${candidate.project_id}`,
    '',
    'Pass that project_id directly if it is the one you mean.',
  ].join('\n');
}

function ambiguityRefusal(name: string, candidates: ProjectRow[]): string {
  const lines = candidates.map((row) => `  • ${row.project_name || '(unnamed)'} — ${row.project_id}`);
  return [
    `"${name}" matches ${candidates.length} projects, so nothing was written or read.`,
    ...lines,
    '',
    'Pass the project_id of the one you mean. Picking for you could file this into the wrong',
    'project\'s memory, which cannot be undone from here.',
  ].join('\n');
}

/**
 * Replace project names with project ids anywhere in a tool's arguments.
 *
 * Never throws: if the project list cannot be fetched, the arguments are handed
 * back untouched and the call proceeds exactly as it would have before, so a
 * degraded lookup can never be worse than not having one.
 */
export async function resolveProjectRefs(args: any, client: DeerdawnClient): Promise<ResolveOutcome> {
  const names = new Set<string>();
  collectNames(args, 0, names, { left: MAX_NODES });
  if (!names.size) return { args };

  let rows: ProjectRow[];
  try {
    const listed = await client.listContextProjects();
    rows = flattenRows(listed?.projects);
  } catch {
    return { args };
  }

  const resolved = new Map<string, string>();
  const unmatched: string[] = [];
  for (const name of names) {
    if (!normalizeProjectName(name) && !legacyNormalizeProjectName(name)) continue;
    const candidates = candidatesFor(name, rows);
    if (candidates.length > 1) return { args, refusal: ambiguityRefusal(name, candidates) };
    if (candidates.length === 1) resolved.set(name, candidates[0].project_id as string);
    else unmatched.push(name);
  }

  // Archived projects are absent from /projects, which would make restoring one
  // by name impossible — the exact call a user makes when the project is not in
  // front of them. Costs a second request only on a miss, which is rare.
  //
  // The explicit limit is load-bearing, not a nicety. The endpoint's default is
  // 10 (it was built for start_session's display notice), and a PARTIAL view
  // here does not merely fail to resolve — it defeats the ambiguity refusal.
  // renameProject has no duplicate-name gate, so two projects CAN share a
  // normalized name; archive both, let one fall outside the page, and this loop
  // sees exactly one candidate, raises no refusal, and rewrites the argument —
  // silently pointing a write at the wrong project. Resolution has to see every
  // row it could match, or it must not claim to have matched uniquely.
  if (unmatched.length) {
    let archived: ProjectRow[] = [];
    let archivedComplete = true;
    try {
      const listed = await client.listArchivedContextProjects(ARCHIVED_SCAN_LIMIT);
      archived = flattenRows(listed?.projects);
      // If the server returned a full page, there may be more we cannot see, so
      // a single match is no longer provably unique.
      archivedComplete = archived.length < ARCHIVED_SCAN_LIMIT;
    } catch {
      archived = [];
    }
    for (const name of unmatched) {
      // THE CURRENT RULE ANSWERS FIRST, EVERYWHERE, BEFORE THE OLD ONE ANSWERS
      // ANYWHERE. The rule it replaced is a fallback for references that used to
      // work ("roadmap c" -> "Roadmap C#"), and it must never outvote an exact
      // match — including an exact match that happens to be archived. With
      // "Roadmap C" archived and "Roadmap C#" live, "Roadmap C" means the
      // archived one: the API then says it is archived and how to restore it,
      // which is the right answer, where the old-rule match would have filed the
      // write into a different project without a word. Two old-rule matches are
      // two candidates, and are refused like any other ambiguity.
      let candidates = candidatesFor(name, archived);
      let fromArchive = candidates.length > 0;
      if (!candidates.length) {
        candidates = candidatesFor(name, rows, 'legacy');
        if (!candidates.length) {
          candidates = candidatesFor(name, archived, 'legacy');
          fromArchive = candidates.length > 0;
        }
      }
      if (candidates.length > 1) return { args, refusal: ambiguityRefusal(name, candidates) };
      if (candidates.length === 1) {
        if (fromArchive && !archivedComplete) {
          return { args, refusal: truncatedArchiveRefusal(name, candidates[0]) };
        }
        resolved.set(name, candidates[0].project_id as string);
      }
      // Still nothing: leave the value alone. The handler and handleApiError
      // report an unknown project exactly as they did before this existed.
    }
  }

  if (!resolved.size) return { args };
  return { args: rewriteNames(args, resolved, 0) };
}
