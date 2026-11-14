/**
 * first-run-import — the gate in front of the automatic CLAUDE.md seed.
 *
 * A first connection used to end with an empty brief: DeerDawn detected the
 * user's CLAUDE.md, printed a tip about `import_local` to STDERR, and stopped.
 * Stderr is the MCP server's log, not the conversation, so for practical
 * purposes that tip was addressed to nobody. Session one therefore proved the
 * opposite of the pitch — you connected a memory product and it knew nothing.
 *
 * So the OFFER now happens, in the conversation rather than on stderr — and the
 * import itself happens when the user says yes, or has opted in once for good
 * (autoImportOptIn, below). Uploading the file unasked solved the visibility
 * problem by giving away the consent one; both are solvable at the same time.
 *
 * Everything else in this module exists to make the import safe once permitted,
 * because a write into someone's memory has exactly one unacceptable failure
 * mode: overwriting a brief they already had. The rules are:
 *
 *   1. FIRST RUN IS PER WORKSPACE, NOT PER ACCOUNT. The old auto-import fired
 *      only when the whole account had no context, so the second repo a user
 *      ever opened got nothing. The unit that matters is this directory.
 *   2. NEVER TWICE. A ledger under ~/.deerdawn records which directories have
 *      been seeded. Deleting an imported project is a decision; re-importing
 *      over it next session would silently undo that decision.
 *   3. NEVER OUR OWN OUTPUT. project-sync writes DeerDawn blocks INTO CLAUDE.md,
 *      AGENTS.md and .cursorrules. Reading those back as if the user wrote them
 *      is a feedback loop that manufactures context out of nothing, so the
 *      DeerDawn-authored regions are stripped before the file is judged.
 *   4. NOTHING LEAVES THE MACHINE IN CLEAR. readUserAuthoredContext masks
 *      secrets out of the file before any caller sees it — a CLAUDE.md is the
 *      file people keep a working connection string in.
 *   5. ONE ATTEMPT PER PROCESS. start_session and the connect-time startup path
 *      can both reach this within milliseconds of each other; without a lock
 *      that race creates the same project twice.
 *
 * Nothing here decides what an import WRITES — that belongs to
 * import_local_context in tools/context-sync.ts, which holds its own
 * no-overwrite merge. This module only decides whether one may start.
 *
 * On-disk instruction surfaces (CLAUDE.md / AGENTS.md / .cursorrules) and the
 * MCP `instructions` field on the wire are separate modules on purpose — see
 * shared-context/src/deerdawnInstructions.js. This module READS the on-disk
 * surface and must never carry directives toward the wire one.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// The on-disk instruction lines, and ONLY those. Imported straight from the leaf
// rather than through instruction-block.ts, which also re-exports the MCP `wire`
// instructions — the two surfaces are separate modules on purpose (see the note
// at the top of shared-context/src/deerdawnInstructions.js) and this module has
// no business holding a reference to the wire one.
import { buildDeerdawnInstructionLines, ownedMarkersFor } from '../../shared-context/src/deerdawnInstructions.js';
// ...and the variants of them written for a hosted registration (still the
// on-disk surface, nothing to do with the wire one). A block this package wrote
// must be recognised as its own whichever catalog it was fitted to.
import { buildOnDiskInstructionLines, type DeerdawnServerKind } from './on-disk-instructions.js';
// The same masker every other capture path uses. A CLAUDE.md is the file people
// keep their working DATABASE_URL in, because it is the file they paste their
// setup notes into — see readUserAuthoredContext.
import { redactSecrets } from './redact.js';
// The one rule for finding DeerDawn's block in a person's file. setup-status.js
// is CommonJS and its declaration shim names only what older callers use, so
// the part read here is typed at the point of use, and read at call time.
import * as setupStatus from '../../shared-context/src/setup-status.js';

const blockFinder = setupStatus as unknown as {
  findManagedBlock(text: string, markers: { open: string; openPattern?: RegExp; close: string }): { start: number; end: number } | null;
};

/** The files a user plausibly keeps a project brief in, in preference order. */
export const LOCAL_CONTEXT_FILENAMES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'] as const;

/**
 * Regions DeerDawn wrote itself. Kept as literal pairs rather than imported from
 * project-sync.ts so this module stays a leaf (tools/context-sync.ts imports
 * both, and project-sync pulls in the whole client).
 */
const DEERDAWN_AUTHORED_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ['<!-- deerdawn:auto-context -->', '<!-- /deerdawn:auto-context -->'],
  ['<!-- deerdawn:start -->', '<!-- deerdawn:end -->'],
  ['<!-- deerdawn:skills:start -->', '<!-- deerdawn:skills:end -->'],
];

/** The @-import line project-sync prepends to CLAUDE.md. Also ours, not theirs. */
const CONTEXT_POINTER_LINE = /^\s*@\.deerdawn-context\.md\s*$/gm;

/**
 * Below this, a file has no brief in it — it is a stub, a pointer, or whatever
 * survived stripping our own blocks. Matches the floor import_local_context has
 * always applied to a raw file, now applied to the user-authored part instead.
 */
const MIN_USER_AUTHORED_CHARS = 50;

// Every well-formed pair, found the way every writer finds its block (whole
// marker lines, outside a code fence: findManagedBlock in shared-context's
// setup-status.js). This used indexOf, and read an unterminated block as "the
// rest of the file is ours too", so one stray marker an editor left behind, or a
// marker quoted in the person's notes, cut everything after it out of the
// import. With no well-formed pair, nothing of the person's is removed.
function removeBetween(text: string, open: string, close: string): string {
  let out = text;
  for (let found = blockFinder.findManagedBlock(out, { open, close }); found; found = blockFinder.findManagedBlock(out, { open, close })) {
    out = out.slice(0, found.start) + out.slice(found.end);
  }
  return out;
}

// The blocks that carry an install token: `<!-- deerdawn:auto-context <token>. ... -->`
// to `<!-- /deerdawn:auto-context <token> -->`. Every token found on an opening
// line is stripped, this install's or another's (a CLAUDE.md copied from another
// machine holds that machine's block): all of it is DeerDawn's text, and none of
// it is the person's project.
const TOKEN_OPEN_LINE = /^[ \t]*<!-- deerdawn:auto-context ([0-9a-f]{32})(?:[. ][^\r\n]*)? -->[ \t]*\r?$/gm;

function stripTokenBlocks(text: string): string {
  let out = text;
  const tokens = new Set<string>();
  for (const match of text.matchAll(TOKEN_OPEN_LINE)) tokens.add(match[1]);
  for (const token of tokens) {
    const markers = ownedMarkersFor(token);
    for (let found = blockFinder.findManagedBlock(out, markers); found; found = blockFinder.findManagedBlock(out, markers)) {
      out = out.slice(0, found.start) + out.slice(found.end);
    }
  }
  return out;
}

/** Everything in `text` that DeerDawn did not write. */
export function stripDeerdawnAuthoredBlocks(text: string): string {
  let out = stripTokenBlocks(text);
  for (const [open, close] of DEERDAWN_AUTHORED_BLOCKS) out = removeBetween(out, open, close);
  return out.replace(CONTEXT_POINTER_LINE, '');
}

// ── DeerDawn boilerplate the user pasted in themselves ───────────────────────
//
// Stripping the MARKED regions above only covers what project-sync wrote. It
// does not cover the section the user WROTE — the "## DeerDawn / Always call
// start_session before your first response / Use DeerDawn before repo search"
// block they copied off our own setup page into their own CLAUDE.md. That text
// is outside every marker, so it read as theirs, went through extraction, and
// came back as the first thing a new user ever sees DeerDawn remember: our own
// instructions, quoted at them, in place of their project.
//
// The cost of the two mistakes is wildly asymmetric. Leaving a stray line of
// boilerplate in a brief is a blemish. Eating a paragraph someone wrote about
// their own project is silent data loss in the one product that must not lose
// what it is given — and the user cannot see it happen, because they never saw
// the import decide anything. So every rule below is built to under-remove, and
// each gate is a conjunction: the ones that would broaden the catch on their own
// are deliberately not there.

/**
 * A line reduced to the part worth comparing. Prose gets re-wrapped, re-bulleted
 * and copied out of a rendered page rather than the source, so the markers of
 * how it was pasted are removed and the sentence underneath is what is matched.
 */
function normalizeInstructionLine(text: string): string {
  return text
    .replace(/^\s{0,8}(?:[-*+]|\d{1,3}[.)])\s+/, '')
    .replace(/[`*_]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    // Trailing sentence punctuation, because the commonest adaptation of our
    // block is to cut the last clause off a line and put a full stop there —
    // "Use DeerDawn before repo search for orientation." is ours with three
    // words removed, and the period alone would have hidden that.
    .replace(/[.,;:!?\s]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * How much of one of our published sentences has to line up before a line counts
 * as a copy of it. Forty consecutive characters of the same sentence is not
 * something two people write independently; it is also short enough to survive
 * the truncation and re-wording that happens when someone adapts the block —
 * "Use DeerDawn before repo search for orientation." is our line with the last
 * three words cut off, and still matches.
 */
const MIN_CANONICAL_OVERLAP_CHARS = 40;

let canonicalLinesCache: string[] | null = null;

/** Our own published instruction lines, normalized, long ones only. */
function canonicalInstructionLines(): string[] {
  if (!canonicalLinesCache) {
    const variants: DeerdawnServerKind[][] = [['local'], ['hosted'], ['hosted_claude'], ['local', 'hosted_claude']];
    canonicalLinesCache = [...new Set([
      ...buildDeerdawnInstructionLines(),
      ...variants.flatMap((kinds) => buildOnDiskInstructionLines(kinds)),
    ])]
      .map((line) => normalizeInstructionLine(line.replace(/^#+\s*/, '')))
      // Drops the "## DeerDawn" heading itself. A heading is three words long and
      // matching on it would be matching on nothing.
      .filter((line) => line.length >= MIN_CANONICAL_OVERLAP_CHARS);
  }
  return canonicalLinesCache;
}

/**
 * When one of our sentences sits inside a longer line, how much of that line it
 * has to account for before the line is ours to delete.
 *
 * The two containment directions are not equally safe. A line that is a FRAGMENT
 * of one of ours is ours with words cut off — nothing else is in it. A line that
 * CONTAINS one of ours may be ours with the user's own sentence glued on, and
 * this repo's own AGENTS.md is exactly that: "**Never narrate context back.**"
 * followed by two of our published sentences. Deleting the line to reach the
 * boilerplate would take their instruction with it, so a line only goes when a
 * single published sentence is nearly the whole of it.
 */
const MIN_CANONICAL_COVERAGE = 0.8;

/** Did this line come out of DeerDawn's published block? */
function descendsFromPublishedLine(line: string): boolean {
  const normalized = normalizeInstructionLine(line);
  if (normalized.length < MIN_CANONICAL_OVERLAP_CHARS) return false;
  return canonicalInstructionLines().some((canonical) => {
    // The user's line is a truncation of ours: all of it is ours.
    if (canonical.includes(normalized)) return true;
    // Ours is embedded in a longer line: only if there is next to nothing else.
    return normalized.includes(canonical)
      && canonical.length / normalized.length >= MIN_CANONICAL_COVERAGE;
  });
}

/**
 * Tool names, as a signal that a paragraph is about operating DeerDawn rather
 * than about the user's project.
 *
 * Every name here contains an underscore, which is the whole reason the list is
 * safe to grep for in prose. `recall` is the one advertised tool that is also an
 * ordinary English word, so it is matched only in a form nobody uses by accident
 * — `recall(` or `recall` in backticks — and never as the bare verb.
 */
const DEERDAWN_TOOL_NAMES = [
  'start_session', 'manage_projects', 'manage_memory', 'manage_tasks',
  'build_subagent_brief', 'browse_skills', 'manage_skills', 'read_tasks',
  // Legacy names are never advertised any more, but they are literal strings in
  // the CLAUDE.md files already on people's disks — which is exactly the text
  // this function reads.
  'get_context', 'read_brief', 'update_context', 'update_brief', 'list_projects',
  'create_project', 'list_context_map', 'search_context', 'import_local_context',
  'get_workspace_overview', 'get_workspace_entities', 'get_project_map',
  'find_known_paths', 'upsert_workspace_entities', 'record_hot_paths',
  'record_debug_finding', 'confirm_claim', 'get_next_best_context',
  'cleanup_context', 'switch_subproject', 'archive_project', 'set_project_parent',
  'rename_project', 'manage_todos', 'mark_resolved', 'sync_skills', 'list_skills',
  'get_skill', 'import_skill_from_github',
];

const TOOL_NAME_PATTERN = new RegExp(`(?<![a-z0-9_])(?:${DEERDAWN_TOOL_NAMES.join('|')})(?![a-z0-9_])`, 'gi');
const CALLISH_RECALL_PATTERN = /(?:`recall`|\brecall\s*\()/gi;
const NAMES_DEERDAWN = /\bdeerdawn\b/i;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.*)$/;

function toolNamesIn(text: string): string[] {
  const found = [
    ...(text.match(TOOL_NAME_PATTERN) || []).map((name) => name.toLowerCase()),
    ...((text.match(CALLISH_RECALL_PATTERN) || []).length ? ['recall'] : []),
  ];
  return [...new Set(found)];
}

/** A line that is telling an agent how to operate DeerDawn. */
function isInstructionalLine(line: string): boolean {
  return toolNamesIn(line).length > 0
    || descendsFromPublishedLine(line)
    || NAMES_DEERDAWN.test(line);
}

/**
 * Shorter than this and a "section" is a personal note, not a pasted block. Our
 * published block is ten lines; the hand-adapted versions of it seen in the wild
 * run seven to nine. A two-line "we call start_session from CI" aside a user
 * wrote about their own setup stays.
 */
const MIN_BOILERPLATE_SECTION_LINES = 4;
/** Distinct tool names before a section reads as a tour of the tool surface. */
const MIN_BOILERPLATE_SECTION_TOOLS = 3;
/** How much of the section has to be instructional before none of it is theirs. */
const MIN_BOILERPLATE_SECTION_DENSITY = 0.7;

/**
 * Below this many code spans the saturation ratio below is noise — one backtick
 * out of one is not evidence of anything.
 */
const MIN_SATURATION_SPANS = 3;
/**
 * How much of a section's code has to be OUR tool surface before the section is
 * about operating DeerDawn rather than about the user's own system.
 *
 * This is the signal that replaces the heading name. Someone writing about their
 * own code names their own things — a file, an endpoint, a script, a class — and
 * those land in backticks alongside ours; a tour of our tool surface names
 * nothing else, because there is nothing else in it to name.
 */
const MIN_TOOL_SPAN_SATURATION = 0.8;

/** Backticked spans, with their backticks, which is how both we and they name things. */
function codeSpans(text: string): string[] {
  return text.match(/`[^`\n]+`/g) || [];
}

/**
 * A section whose code is almost entirely our tool names.
 *
 * Kept separate from the tool COUNT gate above because the two measure opposite
 * things: the count asks whether enough of ours is present, this asks whether
 * anything of theirs is. A section can name five of our tools and still be their
 * runbook; it cannot name five of our tools, nothing of their own, and be theirs.
 */
function isToolSurfaceSaturated(text: string): boolean {
  const spans = codeSpans(text);
  if (spans.length < MIN_SATURATION_SPANS) return false;
  const ours = spans.filter((span) => toolNamesIn(span).length > 0 || NAMES_DEERDAWN.test(span));
  return ours.length / spans.length >= MIN_TOOL_SPAN_SATURATION;
}

type Section = { headingIndex: number; bodyIndices: number[] };

/**
 * Headings and the lines under them.
 *
 * A section ends at the NEXT heading of ANY level, so subsections are their own
 * sections and are judged separately. That is the conservative reading: DeerDawn
 * boilerplate is flat, while a "### Repo structure" nested under a DeerDawn
 * heading is usually where the project's own facts live, and it survives on its
 * own merits instead of being swept up with its parent.
 */
function splitSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  lines.forEach((line, index) => {
    if (HEADING_PATTERN.test(line)) {
      current = { headingIndex: index, bodyIndices: [] };
      sections.push(current);
      return;
    }
    if (current && line.trim()) current.bodyIndices.push(index);
  });
  return sections;
}

/**
 * A whole section that is DeerDawn's own block rather than the user's writing.
 *
 * The heading name used to be a required clause: a section had to be titled
 * something containing "DeerDawn" before any of it could go. That read as the
 * conservative choice and was in fact the fragile one, because it is the one
 * part of a pasted block a person reliably rewrites. "## Session Memory",
 * "## Memory Protocol", "## Context rules" over the same ten lines all walked
 * straight past it, and the line pass then deleted only the sentences that were
 * still verbatim — leaving a mangled half-block ("1.", "2.", "4.") that is worse
 * than either keeping it or dropping it. So the heading is now a hint, not a
 * gate, and provenance is decided on what the section SAYS.
 *
 * Every clause still has to hold. Dropping any one of them broadens the catch to
 * something we are not willing to delete unseen:
 *
 *   - four body lines or more — an aside stays;
 *   - three distinct tool names — one mention is a reference, not a tour;
 *   - seventy percent of the section instructional, so a block carrying real
 *     project facts alongside the boilerplate is kept whole;
 *   - and one of three provenance signals, below.
 *
 * Provenance answers "is this ours or theirs", and any one of these settles it:
 * a line provably copied from our published text; a heading that names us; or a
 * section whose code is our tool surface and nothing else. The third is what
 * catches the version somebody retyped in their own words — those have no
 * copied sentence to find, and the reason they are still ours is that every
 * identifier in them is one of ours. A user writing about their own system
 * cannot help but name their own things, which is what keeps their runbook.
 */
function isBoilerplateSection(lines: string[], section: Section): boolean {
  const heading = (lines[section.headingIndex].match(HEADING_PATTERN) || [])[1] || '';

  const body = section.bodyIndices.map((index) => lines[index]);
  if (body.length < MIN_BOILERPLATE_SECTION_LINES) return false;

  const text = body.join('\n');
  if (toolNamesIn(text).length < MIN_BOILERPLATE_SECTION_TOOLS) return false;

  const ours = body.some(descendsFromPublishedLine)
    || NAMES_DEERDAWN.test(heading)
    || isToolSurfaceSaturated(text);
  if (!ours) return false;

  const instructional = body.filter(isInstructionalLine).length;
  return instructional / body.length >= MIN_BOILERPLATE_SECTION_DENSITY;
}

/**
 * Remove the DeerDawn instructions the user installed into their own file.
 *
 * Three passes, narrowest first:
 *   1. whole sections that are our published block under a DeerDawn heading;
 *   2. individual lines copied from that block, wherever they sit — this is the
 *      common shape, since people paste the lines without the heading;
 *   3. a DeerDawn heading left standing over nothing once (1) or (2) emptied it.
 */
export function stripDeerdawnBoilerplate(text: string): string {
  const lines = text.split('\n');
  const dropped = new Set<number>();

  for (const section of splitSections(lines)) {
    if (!isBoilerplateSection(lines, section)) continue;
    dropped.add(section.headingIndex);
    // The blank lines inside the section go with it; anything the section rule
    // did not cover is not in bodyIndices and is not touched.
    for (let index = section.headingIndex + 1; index <= Math.max(...section.bodyIndices); index += 1) {
      dropped.add(index);
    }
  }

  lines.forEach((line, index) => {
    if (!dropped.has(index) && descendsFromPublishedLine(line)) dropped.add(index);
  });

  // A heading whose body we just emptied.
  //
  // The name is not consulted here either, for the same reason as above: the
  // heading over a pasted block is the part people rewrite, and "## Session
  // Memory" standing alone over nothing is the same litter as "## DeerDawn"
  // standing alone over nothing. What makes this safe is the clause that stays:
  // the section must have HAD a body and every line of it must have been ours.
  // A heading the user left deliberately bare has no body lines and is untouched.
  for (const section of splitSections(lines)) {
    if (dropped.has(section.headingIndex)) continue;
    if (!section.bodyIndices.length) continue;
    if (!section.bodyIndices.every((index) => dropped.has(index))) continue;
    dropped.add(section.headingIndex);
  }

  return lines
    .filter((_, index) => !dropped.has(index))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * The user-authored body of a context file, or null when there isn't one —
 * missing, unreadable, or nothing left once DeerDawn's own blocks come out.
 */
export function readUserAuthoredContext(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  // Both passes, then the floor. Order matters: a file that holds nothing but
  // DeerDawn's own instructions — ours in markers, ours pasted by hand — now
  // falls under MIN_USER_AUTHORED_CHARS and stops being an import at all, rather
  // than seeding a project whose entire brief is our setup page.
  //
  // Redaction is the LAST pass and it is inside this function on purpose. This
  // is the single funnel every reader of a local context file goes through —
  // the manual import, the first-run offer, the preview text, the name
  // detection — so a caller cannot acquire the raw bytes by taking a different
  // route. Every other capture path masks before anything leaves the machine
  // (the Stop-hook transcript, captured shell commands); this one did not, and
  // a CLAUDE.md holding a connection string was parsed into structured fields
  // and pushed verbatim to /extraction, which forwards it to the LLM
  // subprocessor. Mask, don't drop: the sentence around the key is the context
  // worth importing.
  const own = redactSecrets(stripDeerdawnBoilerplate(stripDeerdawnAuthoredBlocks(raw)).trim());
  return own.length > MIN_USER_AUTHORED_CHARS ? own : null;
}

/** The first context file in `dir` that the user actually wrote something in. */
export function findLocalContextFile(dir: string): { path: string; name: string } | null {
  for (const name of LOCAL_CONTEXT_FILENAMES) {
    const candidate = path.join(dir, name);
    if (readUserAuthoredContext(candidate)) return { path: candidate, name };
  }
  return null;
}

/**
 * Which directory is "here"?
 *
 * CLAUDE_PROJECT_DIR is the root the host opened; process.cwd() is wherever the
 * server process happened to start. import_local_context used to gate on one and
 * search the other, so a host that set CLAUDE_PROJECT_DIR could report
 * "Auto-seeded from CLAUDE.md" in the same breath as "no CLAUDE.md found".
 * Resolved in one place now, and validated — an env var set to the STRING
 * "undefined" (what `process.env.X = undefined` actually stores) must not win
 * over a perfectly good cwd.
 */
export function resolveWorkspaceDir(fallback: string = process.cwd()): string {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  if (declared && declared !== 'undefined') {
    try {
      if (fs.statSync(declared).isDirectory()) return declared;
    } catch { /* not a usable directory — fall back */ }
  }
  return fallback;
}

// ── Consent for the unattended import ────────────────────────────────────────
//
// The first-run import reads a file the user never chose to send and uploads it
// — to DeerDawn, and onward to the LLM subprocessor that runs extraction. The
// problem it was built to solve was real: the old "run import_local" tip went to
// STDERR, which is the MCP server's log and not the conversation, so it reached
// nobody and session one proved the opposite of the pitch.
//
// But invisibility and consent are different problems, and uploading the file
// solved the first by giving away the second. So the default is OFF and the
// visibility is kept: the offer is rendered IN the conversation, naming the file
// and the one call that accepts it. That is the least-surprising default in both
// directions — nothing leaves the machine without a person saying so, and nobody
// is left staring at an empty brief wondering what the product does.
//
// Two ways to say yes for good, both of them an explicit act:
//   DEERDAWN_AUTO_IMPORT=1                     (env, per shell or per mcp.json)
//   {"auto_import_local": true}                (~/.deerdawn/config.json)
//
// Read per call, never cached: a user who turns this on mid-session should not
// have to restart the server to be taken at their word.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Has the user asked for local context files to be imported unattended? */
export function autoImportOptIn(): boolean {
  const declared = process.env.DEERDAWN_AUTO_IMPORT;
  if (typeof declared === 'string' && declared.trim()) {
    return TRUTHY.has(declared.trim().toLowerCase());
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(deerdawnHome(), 'config.json'), 'utf8'));
    return cfg?.auto_import_local === true;
  } catch {
    return false;
  }
}

// ── The connect-time global profile seed ─────────────────────────────────────
//
// On connect, an account with no profile yet gets one lifted from the user's own
// instruction files ABOUT THEM: `About me:`, `Preferences:`, `Default stack:`. Only
// ~/.claude/CLAUDE.md and ~/.deerdawn-context.md qualify. A project's CLAUDE.md or
// AGENTS.md is a project note and never fills the profile (journey round 5).
// This lived in index.ts and read files with a bare readFileSync — so it was the
// one reader that went around both rules above. It uploaded without the opt-in
// the project import waits for, and it never passed the file through
// readUserAuthoredContext, so an `About me:` line holding a token travelled in
// clear. Same gate and same funnel as everything else now.

function firstLineValue(text: string, ...keys: string[]): string {
  for (const key of keys) {
    const m = text.match(new RegExp(`^${key}[:\\s]+(.+)`, 'mi'));
    const value = m?.[1]?.trim();
    if (value) return value;
  }
  return '';
}

function firstLineList(text: string, ...keys: string[]): string[] {
  for (const key of keys) {
    const items = firstLineValue(text, key).split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (items.length) return items;
  }
  return [];
}

/**
 * The global-profile patch the user's instruction files support, or null.
 *
 * Null without the standing opt-in: nothing is even read. There is no offer to
 * render here — this runs at connect, outside any conversation — so unattended
 * is the only mode it has, and unattended needs the opt-in.
 */
export function buildGlobalProfileSeed(_dir: string = process.cwd()): Record<string, unknown> | null {
  if (!autoImportOptIn()) return null;
  const candidates = [
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(os.homedir(), '.deerdawn-context.md'),
  ];
  let text: string | null = null;
  for (const file of candidates) {
    text = readUserAuthoredContext(file);
    if (text) break;
  }
  if (!text) return null;

  const patch: Record<string, unknown> = {};
  const profile = firstLineValue(text, 'About me', 'About');
  if (profile) patch.user_profile = profile;
  const prefs = firstLineList(text, 'Preferences', 'Always');
  if (prefs.length) patch.preferences = prefs;
  const stack = firstLineList(text, 'Default stack', 'Tech stack');
  if (stack.length) patch.global_stack = stack;
  if (Object.keys(patch).length === 0) return null;
  // Says this write is the unattended seed: the server never lets it settle the
  // one-time "check your profile" note, which only the person's own save or
  // dismissal does.
  patch.source = 'seed';
  return patch;
}

// ── The ledger ───────────────────────────────────────────────────────────────
//
// Deliberately its own file rather than a key in synced-paths.json: that
// manifest is pruned whenever a directory stops matching a project
// (stripDeerdawnFromDir), and losing the record of an import there would let the
// seed run a second time over context the user has since edited.

type ImportLedgerEntry = {
  project_id: string | null;
  source: string;
  imported_at: string;
  /** false when the target already held context and nothing was overwritten. */
  seeded: boolean;
};

type ImportLedger = { imports: Record<string, ImportLedgerEntry> };

function deerdawnHome(): string {
  // Resolved per call, not at module load: tests sandbox HOME/DEERDAWN_HOME
  // after import, and a captured constant would write into the real home.
  return process.env.DEERDAWN_HOME || path.join(os.homedir(), '.deerdawn');
}

function ledgerPath(): string {
  return path.join(deerdawnHome(), 'imported-paths.json');
}

export function readImportLedger(): ImportLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object') {
      return parsed as ImportLedger;
    }
  } catch { /* missing or corrupt — treat as empty */ }
  return { imports: {} };
}

/**
 * Has this workspace already been seeded?
 *
 * Matched case-insensitively for the same reason surface-state does: the ledger
 * is keyed by the path as first written, and a case difference between
 * "/Users/…/DeerDawn" and "/Users/…/deerdawn" would read as "never imported"
 * and seed a second time.
 */
export function hasImportedLocalContext(dir: string): boolean {
  const target = dir.toLowerCase();
  return Object.keys(readImportLedger().imports).some((key) => key.toLowerCase() === target);
}

export function recordLocalContextImport(
  dir: string,
  entry: { project_id?: string | null; source: string; seeded: boolean },
): void {
  try {
    const ledger = readImportLedger();
    ledger.imports[dir] = {
      project_id: entry.project_id ?? null,
      source: entry.source,
      seeded: entry.seeded,
      imported_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2), 'utf8');
  } catch { /* non-fatal: the in-process lock still prevents a double import */ }
}

// ── One attempt per process ──────────────────────────────────────────────────

const attempts = new Map<string, Promise<unknown>>();

/**
 * Run `job` for `dir` at most once in this process. A second caller gets null
 * rather than its own import — it waits for the first so it cannot race ahead
 * of the ledger write and create the same project twice.
 *
 * The entry is kept after settling, failures included: a session that could not
 * import is not helped by retrying on every subsequent call, and the next
 * session gets a clean attempt anyway.
 */
export function claimFirstRunImport<T>(dir: string, job: () => Promise<T>): Promise<T | null> {
  const key = dir.toLowerCase();
  const existing = attempts.get(key);
  if (existing) return existing.then(() => null, () => null);
  const started = job();
  attempts.set(key, started.catch(() => null));
  return started;
}

/** Test seam — the per-process claim is module state that outlives a test case. */
export function resetFirstRunImportState(): void {
  attempts.clear();
}
