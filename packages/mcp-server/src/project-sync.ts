/**
 * project-sync: writes DeerDawn context into project files so every tool
 * (Claude Code, Codex, Cursor, Copilot, etc.) picks it up automatically.
 *
 * Called on MCP server connect — runs in the background, all errors are
 * non-fatal. Idempotent: safe to run on every session start.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { DeerdawnClient } from './client.js';
import {
  buildSkillsIndexBlock,
  toClaudeSkillMd,
  toCursorMdc,
} from '../../shared-context/src/index.js';
import { safeWriteFileSync, safeMkdirSync, isInsideRoot } from './utils/safe-fs.js';
import * as setupStatus from '../../shared-context/src/setup-status.js';

// How a DeerDawn block is found, refreshed and taken out of a file that is the
// person's: one rule for every writer, in shared-context's setup-status.js (see
// findManagedBlock there). Typed here because that CommonJS module's declaration
// shim names only what older callers use; read at call time.
type BlockMarkers = { open: string; close: string };
const managedBlock = setupStatus as unknown as {
  findManagedBlock(text: string, markers: BlockMarkers): { start: number; end: number } | null;
  upsertManagedBlock(text: string, block: string, options: { markers: BlockMarkers; prepend: boolean }): string;
  removeManagedBlock(text: string, markers: BlockMarkers): string | null;
};

const STACK_DEPS: Record<string, string> = {
  next: 'Next.js', react: 'React', 'react-dom': 'React', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', remix: 'Remix', typescript: 'TypeScript', 'ts-node': 'TypeScript',
  pg: 'PostgreSQL', postgres: 'PostgreSQL', '@neondatabase/serverless': 'Neon/PostgreSQL',
  mysql2: 'MySQL', mongodb: 'MongoDB', mongoose: 'MongoDB',
  redis: 'Redis', ioredis: 'Redis', '@upstash/redis': 'Redis',
  prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle ORM',
  typeorm: 'TypeORM', sequelize: 'Sequelize', zod: 'Zod',
  express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa',
  anthropic: 'Anthropic SDK', '@anthropic-ai/sdk': 'Anthropic SDK', openai: 'OpenAI SDK',
  vitest: 'Vitest', jest: 'Jest', tsup: 'tsup', vite: 'Vite',
  '@clerk/nextjs': 'Clerk', '@clerk/clerk-sdk-node': 'Clerk',
  '@modelcontextprotocol/sdk': 'MCP SDK',
};

function collectPackageJsonPaths(dir: string): string[] {
  const found: string[] = [];
  // Root
  const root = path.join(dir, 'package.json');
  if (fs.existsSync(root)) found.push(root);
  // One level into common monorepo workspace dirs
  for (const wsDir of ['apps', 'packages', 'services', 'libs', 'modules']) {
    const ws = path.join(dir, wsDir);
    if (!fs.existsSync(ws)) continue;
    try {
      for (const entry of fs.readdirSync(ws, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkg = path.join(ws, entry.name, 'package.json');
        if (fs.existsSync(pkg)) found.push(pkg);
      }
    } catch { /* non-fatal */ }
  }
  return found;
}

function inferStackFromDir(dir: string): string[] {
  const labels = new Set<string>();
  for (const pkgPath of collectPackageJsonPaths(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const label = STACK_DEPS[dep];
        if (label) labels.add(label);
      }
    } catch { /* non-fatal */ }
  }
  try {
    const reqPath = path.join(dir, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      for (const line of fs.readFileSync(reqPath, 'utf8').split('\n')) {
        const pkg = line.split(/[>=<!\s]/)[0].toLowerCase().trim();
        if (STACK_DEPS[pkg]) labels.add(STACK_DEPS[pkg]);
      }
    }
  } catch { /* non-fatal */ }
  return Array.from(labels);
}

// Candidate project dirs to scan for config — repo root plus one level into the
// usual monorepo workspace dirs. Mirrors collectPackageJsonPaths' traversal.
function collectProjectDirs(dir: string): string[] {
  const dirs = [dir];
  for (const wsDir of ['apps', 'packages', 'services', 'libs', 'modules']) {
    const ws = path.join(dir, wsDir);
    if (!fs.existsSync(ws)) continue;
    try {
      for (const entry of fs.readdirSync(ws, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(ws, entry.name));
      }
    } catch { /* non-fatal */ }
  }
  return dirs;
}

export type InferredEnvEntity = {
  entity_type: 'environment';
  title: string;
  summary: string;
  scope: 'workspace';
  canonical_key: string;
  metadata: Record<string, unknown>;
};

// Marked 'inferred' (not manual) so a wrong guess is clearly low-confidence and
// distinguishable from a human-curated environment note.
function envMeta(): Record<string, unknown> {
  return { source_kind: 'inferred', curation_state: 'inferred', importance: 'high', status: 'active' };
}

// Infer deploy/hosting topology from committed infra config — the analog of
// inferStackFromDir. The highest-stakes "where does prod actually live" fact
// usually sits in fly.toml / render.yaml / vercel config that NOTHING else in
// the capture pipeline reads, so it never gets stored unless a human says it in
// a captured conversation. Best-effort, regex-only, never throws.
export function inferDeployTargets(dir: string): InferredEnvEntity[] {
  const out = new Map<string, InferredEnvEntity>();
  const add = (e: InferredEnvEntity) => { if (!out.has(e.canonical_key)) out.set(e.canonical_key, e); };
  const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  for (const base of collectProjectDirs(dir)) {
    const rel = path.relative(dir, base) || '.';
    const where = rel === '.' ? 'repo root' : rel;

    const fly = read(path.join(base, 'fly.toml'));
    if (fly) {
      const app = (fly.match(/^\s*app\s*=\s*['"]([^'"]+)['"]/m) || [])[1] || path.basename(base);
      const region = (fly.match(/^\s*primary_region\s*=\s*['"]([^'"]+)['"]/m) || [])[1];
      add({
        entity_type: 'environment', scope: 'workspace', canonical_key: `env:fly:${app}`,
        title: `${app} — Fly.io`,
        summary: `${where} deploys to Fly.io as app '${app}'${region ? ` (region ${region})` : ''}. Config: ${path.join(rel, 'fly.toml')}. Deploy with flyctl (build context is the repo root when the Dockerfile COPYs from root).`,
        metadata: envMeta(),
      });
    }

    // Vercel: .vercel/project.json carries the real project name; vercel.json is
    // the committed fallback. (Vercel often needs no committed file at all, so
    // file-based inference can miss Vercel — a known limitation.)
    const vproj = read(path.join(base, '.vercel', 'project.json'));
    if (vproj) {
      let name = path.basename(base);
      try { name = JSON.parse(vproj).projectName || name; } catch { /* keep basename */ }
      add({
        entity_type: 'environment', scope: 'workspace', canonical_key: `env:vercel:${name}`,
        title: `${name} — Vercel`, summary: `${where} deploys to Vercel (project '${name}').`, metadata: envMeta(),
      });
    } else if (read(path.join(base, 'vercel.json'))) {
      const name = path.basename(base);
      add({
        entity_type: 'environment', scope: 'workspace', canonical_key: `env:vercel:${name}`,
        title: `${name} — Vercel`, summary: `${where} has vercel.json — deploys to Vercel.`, metadata: envMeta(),
      });
    }

    if (read(path.join(base, 'render.yaml'))) {
      add({
        entity_type: 'environment', scope: 'workspace', canonical_key: `env:render:${path.basename(base)}`,
        title: `${path.basename(base)} — Render`, summary: `${where} deploys to Render (render.yaml).`, metadata: envMeta(),
      });
    }
    if (read(path.join(base, 'netlify.toml'))) {
      add({
        entity_type: 'environment', scope: 'workspace', canonical_key: `env:netlify:${path.basename(base)}`,
        title: `${path.basename(base)} — Netlify`, summary: `${where} deploys to Netlify (netlify.toml).`, metadata: envMeta(),
      });
    }
    if (read(path.join(base, 'Procfile'))) {
      add({
        entity_type: 'environment', scope: 'workspace', canonical_key: `env:procfile:${path.basename(base)}`,
        title: `${path.basename(base)} — Procfile host`, summary: `${where} has a Procfile (Heroku/Railway/Dokku-style host).`, metadata: envMeta(),
      });
    }
  }
  return Array.from(out.values());
}

const MARKER_START = '<!-- deerdawn:start -->';
const MARKER_END   = '<!-- deerdawn:end -->';

// Skill markers — distinct from the context block above so a file can carry both
// the DeerDawn context brief and the shared-skills index without collision.
const SKILL_MARKER_START = '<!-- deerdawn:skills:start -->';
const SKILL_MARKER_END   = '<!-- deerdawn:skills:end -->';
const CONTEXT_MARKERS = { open: MARKER_START, close: MARKER_END };
const SKILL_MARKERS = { open: SKILL_MARKER_START, close: SKILL_MARKER_END };
export const SKILL_PREFIX = 'deerdawn-';

// A skill's slug comes from the server and becomes a directory name, a file name
// and — on cleanup — the argument to a RECURSIVE delete. It went into path.join
// exactly as received, so a slug of `x/../../../../.ssh` named a directory outside
// the repo for mkdir, for the write, and later for rmSync. The API's own
// slugifier only ever emits [a-z0-9-], so anything else is not a skill this
// client should touch, whoever sent it: a compromised or self-hosted server, a
// man-in-the-middle, or a hand-edited manifest.
//
// 128 rather than the 64 a slug "ought" to fit in: the API caps a skill NAME at
// 120 characters and derives the slug from it uncapped, so a tighter limit here
// would silently stop real skills from syncing. 128 plus the prefix and `.mdc`
// is still far inside a 255-byte file name.
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
export function isSafeSkillSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SKILL_SLUG_RE.test(slug);
}

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// ── Server-side custody (moat) ───────────────────────────────────────────────
// The rich brief — current task, decisions, stack, open questions, where you
// left off — is delivered LIVE into each session by DeerDawn (start_session /
// injection) and intentionally NOT persisted to disk. Local files become thin
// pointers, so the accumulated context cannot be copied out and reused without a
// live DeerDawn connection. This is what makes leaving expensive: the value
// lives server-side, not in a markdown file the user can walk away with.
//
// Opt out with DEERDAWN_CONTEXT_CUSTODY=false to restore full-brief-on-disk
// behavior (e.g. for offline/air-gapped use where the moat isn't wanted).
export function contextCustodyEnabled(): boolean {
  return process.env.DEERDAWN_CONTEXT_CUSTODY !== 'false';
}

export function buildContextPointer(projectName: string, lastUpdated?: string | null): string {
  const synced = lastUpdated || new Date().toISOString();
  return [
    `Project: ${projectName}`,
    '',
    "This project's brief — current task, recent decisions, tech stack,",
    'open questions, and where you left off — is maintained by DeerDawn and',
    'delivered into your session at start. It is intentionally NOT written to disk.',
    '',
    'Run `start_session` (DeerDawn MCP) to load the current brief. Without a live',
    'DeerDawn connection this file is only a pointer — the brief lives server-side.',
    `Last briefed: ${synced}`,
    '',
    'Your project brief, maintained by DeerDawn — every new session starts briefed: https://deerdawn.com',
  ].join('\n');
}

// Manifest of directories DeerDawn has written briefs into, so a directory that
// stops matching a project can have its orphaned brief cleaned up later. Without
// this, a brief written into the wrong dir lingers forever and contradicts the
// real one (the original "two context files disagree" bug).
const MANIFEST_PATH = path.join(os.homedir(), '.deerdawn', 'synced-paths.json');

type SyncManifest = { paths: Record<string, { project_id: string | null; written_at: string; infra_sig?: string; skills?: Record<string, string> }> };

function readManifest(): SyncManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.paths) return parsed as SyncManifest;
  } catch { /* missing/corrupt — start fresh */ }
  return { paths: {} };
}

function writeManifest(manifest: SyncManifest): void {
  try {
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    safeWriteFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

// Remove DeerDawn-managed content from a directory. The standalone
// .deerdawn-context.md is wholly ours, so delete it; marker-patched files
// belong to the user, so strip only the deerdawn block and leave the rest.
function stripDeerdawnFromDir(dir: string): void {
  try {
    const ctx = path.join(dir, '.deerdawn-context.md');
    if (fs.existsSync(ctx)) fs.unlinkSync(ctx);
  } catch { /* non-fatal */ }

  // Remove only the namespaced skill artifacts WE recorded in the manifest —
  // never a blanket rmSync of .claude/skills or .cursor/rules (those hold
  // user-authored skills/rules too). .cursorrules is never a skill sink.
  const recordedSkills = readManifest().paths[dir]?.skills ?? {};
  //
  // The manifest is a local JSON file, which makes it input, not a record to be
  // trusted: each slug is checked for shape, and each target is checked to still
  // resolve inside its own skills directory, BEFORE a recursive delete is aimed
  // at it. A `.claude/skills` that is a link to somewhere else fails the second
  // check even with a well-formed slug.
  const claudeSkillsDir = path.join(dir, '.claude', 'skills');
  const cursorRulesDir = path.join(dir, '.cursor', 'rules');
  for (const slug of Object.keys(recordedSkills)) {
    if (!isSafeSkillSlug(slug)) {
      console.error('[DeerDawn] Ignoring a recorded skill whose slug is not a valid skill name — nothing deleted for it');
      continue;
    }
    const skillDir = path.join(claudeSkillsDir, SKILL_PREFIX + slug);
    const mdc = path.join(cursorRulesDir, `${SKILL_PREFIX + slug}.mdc`);
    try {
      if (isInsideRoot(skillDir, dir) && path.dirname(skillDir) === claudeSkillsDir) {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    } catch { /* non-fatal */ }
    try {
      if (isInsideRoot(mdc, dir) && path.dirname(mdc) === cursorRulesDir) fs.rmSync(mdc, { force: true });
    } catch { /* non-fatal */ }
  }

  // Only a well-formed pair comes out, and nothing else in the file changes. It
  // used to be a lazy START..END regex from wherever START first appeared (a
  // quote of it in the person's docs included), followed by collapsing every run
  // of blank lines in the whole file.
  for (const rel of ['AGENTS.md', '.cursorrules', path.join('.github', 'copilot-instructions.md')]) {
    try {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) continue;
      const original = fs.readFileSync(p, 'utf8');
      let next = original;
      for (const markers of [CONTEXT_MARKERS, SKILL_MARKERS]) next = managedBlock.removeManagedBlock(next, markers) ?? next;
      if (next !== original) safeWriteFileSync(p, next, 'utf8', dir);
    } catch { /* non-fatal */ }
  }
}

export function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return null;
}

// A well-formed pair is refreshed in place; with none, the block is prepended so
// it appears at the top of the file. It used to be found with includes(START)
// and a lazy START..END regex: a repo whose AGENTS.md documents the markers had
// the text between a quoted START and the next END replaced, and a lone START
// meant the block was never written at all.
function patchWithMarkers(
  existing: string,
  block: string,
  markerStart: string = MARKER_START,
  markerEnd: string = MARKER_END,
): string {
  const markerBlock = `${markerStart}\n${block}\n${markerEnd}`;
  return managedBlock.upsertManagedBlock(existing, markerBlock, { markers: { open: markerStart, close: markerEnd }, prepend: true });
}

function patchWithSkillMarkers(existing: string, block: string): string {
  return patchWithMarkers(existing, block, SKILL_MARKER_START, SKILL_MARKER_END);
}

/**
 * Does this file already carry DeerDawn's block (a well-formed pair, found the way
 * every writer finds it)? A sync that names no tool refreshes a tool's file only
 * when it does: it never adds a tool's file that nobody asked for.
 */
function carriesBlock(file: string, markers: BlockMarkers): boolean {
  try {
    return managedBlock.findManagedBlock(fs.readFileSync(file, 'utf8'), markers) !== null;
  } catch {
    return false;
  }
}

// Distribute enabled shared skills to disk for every connected tool. Three
// safety properties hold by construction:
//   • namespaced  — every artifact is deerdawn-<slug>, so user-authored skills
//                   and rules are never touched.
//   • custody-bypassed — skills are valuable ON disk; the context custody moat
//                   does NOT apply, so the full body is always written.
//   • skip-not-overwrite — if a recorded file's on-disk hash no longer matches
//                   what we last wrote, a human edited it: log and skip.
// Per-skill sinks (Claude dir, Cursor .mdc) get the FULL body. Always-on shared
// files (AGENTS.md, copilot-instructions.md) get an INDEX block only — never a
// full body. .cursorrules is deliberately excluded (context-only).
async function writeSkills(client: DeerdawnClient, gitRoot: string, manifest: SyncManifest, tools?: ProjectSyncTool[]): Promise<void> {
  // With a tool named (setup), that tool's sinks are written. With none (a boot,
  // start_session), a sink is updated only if it is already there: the skill's
  // file exists, or the file's index block does.
  const may = (tool: ProjectSyncTool, alreadyThere: boolean): boolean => (tools ? tools.includes(tool) : alreadyThere);
  const listed = (await client.listSkills().catch(() => []))
    .filter((s) => s.enabled);
  // Dropped here, before the fetch, the write, the AGENTS.md index and the
  // manifest — an unsafe slug must not reach any of them. See isSafeSkillSlug.
  const skills = listed.filter((s) => isSafeSkillSlug(s.slug));
  if (skills.length !== listed.length) {
    console.error(`[DeerDawn] Skipped ${listed.length - skills.length} shared skill(s) whose slug is not a valid skill name`);
  }

  const prior = manifest.paths[gitRoot]?.skills ?? {};
  const writtenNow: Record<string, string> = {};

  // Fetch every skill body concurrently — this used to be N sequential awaited
  // round-trips, which grew start-of-session latency linearly with skill count.
  const fulls = await Promise.all(skills.map((m) => client.getSkill(m.slug).catch(() => null)));

  for (let si = 0; si < skills.length; si++) {
    const meta = skills[si];
    const full = fulls[si];
    if (!full?.markdown_content) continue;
    const namespaced = SKILL_PREFIX + meta.slug;
    const sig = hash(full.markdown_content);
    let handled = false;

    // Claude Code — full SKILL.md in a namespaced dir (custody bypassed).
    try {
      const dir = path.join(gitRoot, '.claude', 'skills', namespaced);
      const file = path.join(dir, 'SKILL.md');
      if (!may('claude_code', fs.existsSync(file))) {
        // not written unasked
      } else if (fs.existsSync(file) && prior[meta.slug] && hash(fs.readFileSync(file, 'utf8')) !== prior[meta.slug]) {
        console.error(`[DeerDawn] Skill ${namespaced} edited locally — skipping overwrite`);
        handled = true;
      } else {
        handled = true;
        if (safeMkdirSync(dir, gitRoot)) {
          safeWriteFileSync(file, toClaudeSkillMd(meta, full.markdown_content), 'utf8', gitRoot);
        }
      }
    } catch { /* non-fatal */ }

    // Cursor — full .mdc with Cursor frontmatter, namespaced.
    try {
      const mdc = path.join(gitRoot, '.cursor', 'rules', `${namespaced}.mdc`);
      if (!may('cursor', fs.existsSync(mdc))) {
        // not written unasked
      } else if (fs.existsSync(mdc) && prior[meta.slug] && hash(fs.readFileSync(mdc, 'utf8')) !== prior[meta.slug]) {
        console.error(`[DeerDawn] Skill ${namespaced}.mdc edited locally — skipping overwrite`);
        handled = true;
      } else {
        handled = true;
        if (safeMkdirSync(path.dirname(mdc), gitRoot)) {
          safeWriteFileSync(mdc, toCursorMdc(meta, full.markdown_content), 'utf8', gitRoot);
        }
      }
    } catch { /* non-fatal */ }

    // Recorded once a sink for it was written (or held back for a local edit); a
    // skill nothing was written for keeps the record it had.
    if (handled) writtenNow[meta.slug] = sig;
    else if (prior[meta.slug]) writtenNow[meta.slug] = prior[meta.slug];
  }

  // AGENTS.md (always) + copilot-instructions.md (only if it exists) — index
  // block ONLY, marker-patched into the user-owned file. Never .cursorrules.
  const indexBlock = buildSkillsIndexBlock(skills.map((s) => ({ name: s.name, description: s.description, slug: s.slug })));
  if (indexBlock) {
    const targets: string[] = [];
    const agents = path.join(gitRoot, 'AGENTS.md');
    if (may('codex', carriesBlock(agents, SKILL_MARKERS))) targets.push(agents);
    const copilot = path.join(gitRoot, '.github', 'copilot-instructions.md');
    if (fs.existsSync(copilot) && may('copilot', carriesBlock(copilot, SKILL_MARKERS))) targets.push(copilot);
    for (const p of targets) {
      try {
        const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        safeWriteFileSync(p, patchWithSkillMarkers(existing, indexBlock), 'utf8', gitRoot);
      } catch { /* non-fatal */ }
    }
  }

  manifest.paths[gitRoot] = { ...manifest.paths[gitRoot], skills: writtenNow };
}

function parsePlanProgress(dir: string): string | null {
  try {
    const plansDir = path.join(dir, 'docs', 'superpowers', 'plans');
    if (!fs.existsSync(plansDir)) return null;
    const files = fs.readdirSync(plansDir).filter((f: string) => f.endsWith('.md'));
    if (!files.length) return null;
    const latest = files
      .map((f: string) => ({ f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)[0].f;
    const content = fs.readFileSync(path.join(plansDir, latest), 'utf8');
    const checked = (content.match(/\[x\]/gi) || []).length;
    const unchecked = (content.match(/\[ \]/g) || []).length;
    const total = checked + unchecked;
    if (total === 0) return null;
    const name = latest.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
    return `${checked}/${total} steps complete (${name})`;
  } catch {
    return null;
  }
}

/** The exact shape parsePlanProgress emits — how we recognise our own writes. */
const PLAN_PROGRESS_RE = /^\d+\/\d+ steps complete \(/;

export function isPlanDerivedProgress(value: string): boolean {
  return PLAN_PROGRESS_RE.test(String(value || '').trim());
}

/**
 * The STORED context for this project, or null when it could not be read.
 *
 * Never returns an empty object as a stand-in for "unknown": every caller here
 * is about to diff a derived guess against it, and a null-as-empty read is what
 * turned this sync into an overwrite. `tech_stack` is always an array on the
 * structured shape (createContextObject defaults it), so its absence means the
 * read did not land — an older API build answering format=json with its
 * ordinary brief payload, for one.
 */
async function readStoredContext(
  client: DeerdawnClient,
  result: any,
): Promise<Record<string, any> | null> {
  const structured = (ctx: any) =>
    ctx && typeof ctx === 'object' && Array.isArray(ctx.tech_stack) ? (ctx as Record<string, any>) : null;
  // A caller that already fetched the JSON shape (not the brief) saves a hop.
  const inline = structured(result?.context);
  if (inline) return inline;
  try {
    return structured(await client.getContextJson(result.project_id));
  } catch {
    return null;
  }
}

/**
 * Does this match_kind say "this directory IS that project"?
 *
 * 'path' was the only kind accepted, from when it was the only location signal
 * the server had. It has two more now, and both are at least as strong:
 *   - 'pinned': the user ran switch_subproject for THIS repo. The client sends
 *     workspace_key on every call, so once a pin exists every resolve in the repo
 *     comes back 'pinned' and never 'path' again.
 *   - 'workspace': the project carries this repo's own workspace key.
 * Reading either as "no match" did not merely skip the write: the branch below
 * treats a non-match in a directory we wrote before as a STALE brief and strips
 * it. So pinning a subproject deleted the repo's on-disk brief on the next sync,
 * and every sync after.
 */
export function isLocationMatch(matchKind: unknown): boolean {
  return matchKind === 'path' || matchKind === 'pinned' || matchKind === 'workspace';
}

/**
 * `tools` is full setup for the tool(s) named: those tools' files are written,
 * created if need be. Left out (a boot, start_session), a tool's file is only
 * refreshed when it already carries DeerDawn's block.
 */
export type ProjectSyncTool = 'claude_code' | 'codex' | 'cursor' | 'copilot';

export async function syncProjectFiles(
  client: DeerdawnClient,
  cwd: string,
  prefetched?: any,
  options: { tools?: ProjectSyncTool[] } = {},
): Promise<string | null> {
  const writes = (tool: ProjectSyncTool): boolean => !options.tools || options.tools.includes(tool);
  try {
    // Reuse a context result the caller already fetched for this cwd (e.g.
    // start_session fetched it moments ago) to skip a redundant ~900ms
    // /context/active round-trip. Fall back to fetching when no usable prefetch
    // is supplied (background boot, other callers, or a null/errored result).
    const result = (prefetched && prefetched.project_name && prefetched.match_kind)
      ? prefetched
      : await client.getActiveContextByCwd(cwd, 'claude_code', 'standard');

    const gitRoot = findGitRoot(cwd) || cwd;
    const manifest = readManifest();

    // Only write a brief when this directory genuinely maps to the project.
    // 'recency_fallback'/'name' guesses must never be written to disk — that
    // recency fallback is exactly what wrote a misleading brief into an unrelated
    // directory and produced contradictory context files.
    const isRealMatch = Boolean(result?.brief && result?.project_name && isLocationMatch(result?.match_kind));
    if (!isRealMatch) {
      // If we previously wrote here but this dir no longer matches, clean it up.
      if (manifest.paths[gitRoot]) {
        stripDeerdawnFromDir(gitRoot);
        delete manifest.paths[gitRoot];
        writeManifest(manifest);
        console.error(`[DeerDawn] Removed stale brief at ${gitRoot} — directory no longer linked to a project`);
      } else {
        console.error(`[DeerDawn] No project linked to ${gitRoot} — skipping brief write`);
      }
      return null;
    }

    const brief = result.brief;

    // Server-side custody: under custody (default) the on-disk copy is a thin
    // pointer, not the brief. The full brief is still delivered live by
    // start_session (the on-disk pointer != brief, so its dedup always sends the
    // full brief in-session). Set DEERDAWN_CONTEXT_CUSTODY=false to persist the
    // full brief to disk as before.
    const diskBrief = contextCustodyEnabled()
      ? buildContextPointer(result.project_name, (result as any).last_updated)
      : brief;

    // A sync that names no tool (a boot, start_session) only refreshes what is
    // already there: a file that carries DeerDawn's block, and the context file
    // beside a CLAUDE.md that points at it. It never adds a tool's file. A sync
    // that names the tool (setup) writes that tool's files.
    const named = Boolean(options.tools);
    const claudeMdPath = path.join(gitRoot, 'CLAUDE.md');
    const contextFilePath = path.join(gitRoot, '.deerdawn-context.md');
    const claudePointed = fs.existsSync(claudeMdPath) && fs.readFileSync(claudeMdPath, 'utf8').includes('@.deerdawn-context.md');

    // 1. Write .deerdawn-context.md (Claude Code reads via @.deerdawn-context.md in CLAUDE.md)
    if (named ? writes('claude_code') : (claudePointed || fs.existsSync(contextFilePath))) {
      safeWriteFileSync(contextFilePath, `${diskBrief}\n`, 'utf8', gitRoot);
    }

    // 2. Patch CLAUDE.md to include @.deerdawn-context.md (Claude Code)
    if (!named || !writes('claude_code')) {
      // not this call's to write
    } else if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, 'utf8');
      if (!existing.includes('@.deerdawn-context.md')) {
        safeWriteFileSync(claudeMdPath, `@.deerdawn-context.md\n\n${existing}`, 'utf8', gitRoot);
      }
    } else {
      safeWriteFileSync(claudeMdPath, `@.deerdawn-context.md\n`, 'utf8', gitRoot);
    }

    // 3. Patch AGENTS.md with DeerDawn block (Codex)
    const agentsMdPath = path.join(gitRoot, 'AGENTS.md');
    if (named ? writes('codex') : carriesBlock(agentsMdPath, CONTEXT_MARKERS)) {
      const existingAgents = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf8') : '';
      const agentsBlock = `## DeerDawn Context\n\n${diskBrief}`;
      safeWriteFileSync(agentsMdPath, patchWithMarkers(existingAgents, agentsBlock), 'utf8', gitRoot);
    }

    // 4. Patch .cursorrules with DeerDawn block (Cursor)
    const cursorRulesPath = path.join(gitRoot, '.cursorrules');
    if (named ? writes('cursor') : carriesBlock(cursorRulesPath, CONTEXT_MARKERS)) {
      const existingRules = fs.existsSync(cursorRulesPath) ? fs.readFileSync(cursorRulesPath, 'utf8') : '';
      const cursorBlock = `## DeerDawn Context\n\n${diskBrief}`;
      safeWriteFileSync(cursorRulesPath, patchWithMarkers(existingRules, cursorBlock), 'utf8', gitRoot);
    }

    // 5. Patch .github/copilot-instructions.md (GitHub Copilot)
    try {
      const copilotDir = path.join(gitRoot, '.github');
      const copilotPath = path.join(copilotDir, 'copilot-instructions.md');
      if (fs.existsSync(copilotPath) && (named ? writes('copilot') : carriesBlock(copilotPath, CONTEXT_MARKERS))) {
        const existing = fs.readFileSync(copilotPath, 'utf8');
        const block = `## DeerDawn Context\n\n${diskBrief}`;
        safeWriteFileSync(copilotPath, patchWithMarkers(existing, block), 'utf8', gitRoot);
      }
    } catch { /* non-fatal */ }

    // 6. Distribute shared skills to disk (Claude/Cursor full bodies; AGENTS.md +
    //    copilot index block). Dark by default — listSkills returns [] until the
    //    feature is enabled, in which case writeSkills is a no-op. Non-fatal.
    // Shared skills follow the same rule (see writeSkills).
    await writeSkills(client, gitRoot, manifest, options.tools).catch(() => { /* non-fatal */ });

    // ── Derived context (inferred stack, plan-file progress) ────────────────
    //
    // These two writes are GUESSES about a project the user also curates by
    // hand, and `tech_stack` has REPLACE semantics on the merge (a delta array
    // overwrites, so the dashboard can delete an entry). So a guess sent as the
    // whole array is a wipe, and that is exactly what happened: this sync runs
    // on the BRIEF payload from /context/active, which carries no `context`
    // object at all — `result.context?.tech_stack` was always undefined, every
    // inferred label read as new, and the patch replaced a curated stack with
    // whatever the dependency table recognised.
    //
    // Absent is not empty. Read the stored context explicitly and diff against
    // it; when it cannot be read, write nothing. A missed guess costs nothing —
    // the next sync makes it again — and an unasked-for overwrite is
    // unrecoverable.
    if (result.project_id) {
      const inferred = inferStackFromDir(gitRoot || cwd);
      const planProgress = parsePlanProgress(gitRoot || cwd);
      if (inferred.length || planProgress) {
        const stored = await readStoredContext(client, result);
        if (!stored) {
          console.error('[DeerDawn] Derived context skipped — could not read the stored context to diff against');
        } else {
          // Stack: union, and only written when it genuinely ADDS something.
          const existingStack = (stored.tech_stack || []) as string[];
          const newEntries = inferred.filter(s => !existingStack.some(e => e.toLowerCase() === s.toLowerCase()));
          if (newEntries.length) {
            await client.patchProjectContext(result.project_id, {
              tech_stack: [...existingStack, ...newEntries],
            }).catch(() => { /* non-fatal */ });
          }

          // Progress: refresh our OWN derived value, never somebody else's.
          // A plan file is evidence about the plan, not about the task an agent
          // deliberately described, so "6/10 on the migration" set by hand stays.
          if (planProgress) {
            const existingProgress = String(stored.task_progress || '').trim();
            const isOurs = !existingProgress || isPlanDerivedProgress(existingProgress);
            if (isOurs && planProgress !== existingProgress) {
              await client.patchProjectContext(result.project_id, {
                task_progress: planProgress,
              }).catch(() => { /* non-fatal */ });
            }
          }
        }
      }
    }

    // Infer deploy/hosting topology from infra config and persist as workspace
    // 'environment' entities — the "where does prod live" knowledge no other
    // capture path reads. Idempotent (upsert by canonical_key); a manifest
    // signature gates it so it only fires when the inferred set changes.
    let infraSig = manifest.paths[gitRoot]?.infra_sig;
    try {
      const envEntities = inferDeployTargets(gitRoot || cwd);
      if (envEntities.length) {
        const sig = envEntities.map(e => e.canonical_key).sort().join('|');
        if (sig !== infraSig) {
          await client.upsertWorkspaceEntities({ entities: envEntities }).catch(() => { /* non-fatal */ });
          infraSig = sig;
        }
      }
    } catch { /* non-fatal */ }

    // Preserve the skills map writeSkills recorded above — it lives under the
    // same manifest.paths[gitRoot] key this assignment rebuilds.
    const recordedSkills = manifest.paths[gitRoot]?.skills;
    manifest.paths[gitRoot] = {
      project_id: result.project_id || null,
      written_at: new Date().toISOString(),
      ...(infraSig ? { infra_sig: infraSig } : {}),
      ...(recordedSkills ? { skills: recordedSkills } : {}),
    };
    writeManifest(manifest);

    console.error(`[DeerDawn] Synced "${result.project_name}" → ${gitRoot}`);
    return result.project_name;
  } catch (err: any) {
    // Non-fatal — context files are a nice-to-have, not required
    console.error(`[DeerDawn] Project sync skipped — ${err?.message ?? 'unknown error'}`);
    return null;
  }
}
