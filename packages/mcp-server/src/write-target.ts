// Which project may a write with no project_id go to?
//
// READS AND WRITES DO NOT GET THE SAME ANSWER. `/active` resolves "the project
// for this directory" from whatever signal it has, and the weakest of those is
// `name`: the project's name CONTAINS the folder's basename. A folder called
// `api` matches "Acme API", "Rapid Prototype" and "Therapist notes" alike. That
// is a fair thing to SHOW somebody, flagged as a guess, and start_session does.
// It is no basis for deciding where their memory is filed, because a wrong write
// cannot be undone from the tool that made it — and every write path here used
// to take `active.project_id` without ever looking at how it had been matched.
//
// So a write asks for a write target (`purpose=write`) and then JUDGES the
// answer instead of trusting it. The judging is not optional politeness: this
// package is published on its own schedule, and the API that understands
// `purpose` may deploy after it. An older API ignores the parameter and answers
// with the name guess exactly as before, carrying no `write_target` field, so
// the rule the newer API applies server-side is applied again here from
// `match_kind`. Same verdict either way, whichever side ships first.
//
// What a refusal costs depends on who is asking, which is why this module only
// REPORTS the verdict and each caller decides what to do with it:
//   - a passive capture hook drops the event. Nobody asked for it, nobody is
//     reading its output, and an error on every Bash call is noise.
//   - an explicit tool call says so, names the guess and its id, and tells the
//     caller to pass project_id. It is one retry away from working, and the
//     write that names a project also links the directory, so it is the last
//     time that retry is needed.

import path from 'path';
import { workspaceKeyForCwd, type DeerdawnClient } from './client.js';
import { liveCredential } from './auth-state.js';

/** The part of an `/active` answer this module reads. */
export interface ActiveMatch {
  project_id?: string | null;
  project_name?: string | null;
  match_kind?: string | null;
  match_confidence?: string | null;
  write_target?: boolean | null;
}

// The kinds that say "this directory IS that project", for an API that sends no
// `write_target`. Deliberately the same three project-sync's isLocationMatch
// accepts before it will write a brief to disk: a match that is not good enough
// to put a file in the repo is not good enough to put a decision in the project.
// An absent match_kind is not on the list. Every API that resolves by cwd sends
// one, so "absent" means the answer did not come from location at all.
const WRITE_GRADE_MATCH_KINDS = new Set(['path', 'pinned', 'workspace']);

// ─── A workspace key that is only a folder name ──────────────────────────────
//
// getWorkspaceKey identifies a repo by its git remote, and a repo with no remote
// by `root:<basename of the git root>`. Two unrelated folders that are both
// called `app` therefore share the key `root:app`, and everything the server
// keys on it crosses between them: a project stamped in one is a `workspace`
// match in the other, and a subproject pinned in one is `pinned` in the other.
//
// The key itself is left alone, on purpose. The server matches it by equality
// against what it already stored (context_projects.workspace_key, and the pin
// keyed by owner + workspace key), and this client can send exactly one key per
// request — so a collision-resistant form (a hash of the real path, say) would
// stop matching every project and every pin already stored under the old form,
// for every local-only repo, with nothing on this side able to migrate them.
// That needs the API to accept both spellings; it is not a client-only change.
//
// What CAN be decided here is how far such a match is trusted. For reading, as
// far as before. For writing, not at all: a `workspace` or `pinned` answer
// reached through a folder-name key is treated like a name guess, because that
// is what it is. A `path` match is untouched — it never involved the key — and
// so is anything this process was told directly (see rememberWriteTarget). The
// cost lands on a local-only repo with a PINNED subproject, whose saves now need
// project_id; the refusal says why, and names the project and its id.
export function isFolderNameWorkspaceKey(workspaceKey: string | null | undefined): boolean {
  return typeof workspaceKey === 'string' && workspaceKey.startsWith('root:');
}

function reachedThroughFolderNameKey(active: ActiveMatch, workspaceKey: string | null | undefined): boolean {
  return isFolderNameWorkspaceKey(workspaceKey) && (active.match_kind === 'workspace' || active.match_kind === 'pinned');
}

/**
 * May a write with no project_id land in this `/active` answer?
 *
 * `write_target` wins when the API sent it — it is the server's own verdict and
 * it knows things this side does not (a hosted caller with no location may write
 * to its own recency fallback; one with a location never gets that answer).
 * Without it, `match_confidence: 'high'` is the same verdict in its other
 * spelling, and without either the verdict is derived from `match_kind`.
 */
export function isWriteGradeMatch(active: ActiveMatch | null | undefined, workspaceKey?: string | null): boolean {
  if (!active?.project_id) return false;
  // Before write_target: the server cannot know that the key it matched on is
  // shared with an unrelated folder. Only this side has seen where it came from.
  if (reachedThroughFolderNameKey(active, workspaceKey)) return false;
  if (typeof active.write_target === 'boolean') return active.write_target;
  if (active.match_confidence === 'high') return true;
  return WRITE_GRADE_MATCH_KINDS.has(String(active.match_kind || ''));
}

/**
 * Should start_session flag this answer as a best guess?
 *
 * The notice hard-coded `match_kind === 'name'`, which is one API's spelling of
 * the question rather than the question. The API now answers it directly:
 * `match_confidence: 'low'` is "this is a guess", and `write_target: false` is
 * "and your saves will not follow it". Either field decides when present, so a
 * kind added server-side tomorrow is flagged without a release of this package.
 *
 * NOT the inverse of isWriteGradeMatch. With neither field, only the kinds KNOWN
 * to be guesses are flagged: an answer with no match_kind at all is refused as a
 * write target (nothing says it came from here), but telling somebody their
 * project is "a best guess" on the strength of a field being absent would be a
 * claim with nothing behind it.
 */
export function isGuessedMatch(active: ActiveMatch | null | undefined): boolean {
  if (!active?.project_id) return false;
  const confidence = typeof active.match_confidence === 'string' ? active.match_confidence : null;
  const writeTarget = typeof active.write_target === 'boolean' ? active.write_target : null;
  if (confidence !== null || writeTarget !== null) return confidence === 'low' || writeTarget === false;
  return active.match_kind === 'name' || active.match_kind === 'recency_fallback';
}

// ─── What THIS PROCESS was told about this directory ─────────────────────────
//
// The refusal above has one legitimate casualty: the person in a brand-new repo.
// Their project was created seconds ago, by this process, from this directory —
// and it is typically NAMED after the directory, so against an API that does not
// yet stamp a workspace key at creation the only thing `/active` can say about
// it is `name`. Refusing their first save as "a guess" would be refusing the one
// write whose destination is not in doubt.
//
// It is not a guess because of where the knowledge comes from: not from a
// substring, but from this process having been asked to create (or pin, or
// import into) that project while standing in this directory. So that is
// remembered, per directory, for the life of the process, and consulted ONLY
// when the server has no write-grade answer — a linked path or a pin always
// outranks it. It is deliberately not persisted: the first explicit write links
// the directory server-side, after which `/active` answers `path` by itself, and
// a note on disk would outlive the facts it was written from.
//
// Stamped with the CREDENTIAL that resolved it. A running process can have its
// key replaced underneath it — credentials.json is the only channel between two
// server processes sharing one HOME, and on a shared machine the person at the
// next desk signing in writes the same file. Everything in this map was
// resolved while the previous key was live, so its project ids belong to
// whoever was signed in then; following one under a new credential is how a
// write lands in the wrong person's memory. An entry whose credential is no
// longer the live one is therefore not a target, and is dropped on sight.
const knownTargets = new Map<string, { projectId: string; projectName: string | null; credential: string | null }>();

function directoryKey(cwd: string): string {
  try { return path.resolve(cwd); } catch { return cwd; }
}

export function rememberWriteTarget(cwd: string | null | undefined, projectId: unknown, projectName?: unknown): void {
  if (!cwd || typeof projectId !== 'string' || !projectId) return;
  knownTargets.set(directoryKey(cwd), {
    projectId,
    projectName: typeof projectName === 'string' && projectName ? projectName : null,
    credential: liveCredential(),
  });
}

/** The remembered target for this directory, if the key that resolved it is still live. */
function knownTargetFor(cwd: string): { projectId: string; projectName: string | null } | null {
  const key = directoryKey(cwd);
  const known = knownTargets.get(key);
  if (!known) return null;
  if (known.credential !== liveCredential()) {
    knownTargets.delete(key);
    return null;
  }
  return { projectId: known.projectId, projectName: known.projectName };
}

/** Test seam: a process-wide map would otherwise leak between cases. */
export function forgetWriteTargets(): void {
  knownTargets.clear();
}

export type WriteTargetGuessReason = 'name' | 'recency' | 'folder_key' | 'parent_folder' | 'unverified';

export type WriteTarget =
  | { kind: 'target'; projectId: string; projectName: string | null }
  // Something resolved, but not on a signal a write may follow.
  | { kind: 'guess'; projectId: string; projectName: string | null; reason: WriteTargetGuessReason }
  | { kind: 'none' };

function guessReason(active: ActiveMatch, workspaceKey: string | null): WriteTargetGuessReason {
  if (reachedThroughFolderNameKey(active, workspaceKey)) return 'folder_key';
  if (active.match_kind === 'name') return 'name';
  if (active.match_kind === 'recency_fallback') return 'recency';
  // A parent folder of this directory is linked to the project, but this
  // directory is another or unknown repository: read, never written to.
  if (active.match_kind === 'ancestor_path') return 'parent_folder';
  return 'unverified';
}

/**
 * Resolve the project a write from `cwd` may go to.
 *
 * `nameTheGuess` is for callers that will TELL somebody about a refusal. The
 * newer API answers a write request that only matched by name with nothing at
 * all, so naming the candidate costs one more (read) request — paid only on the
 * refusal path, and never by a hook, which has nobody to tell.
 *
 * Never throws: an unreachable API is "no target", which is what every caller
 * already did with a failed lookup.
 */
export async function resolveWriteTarget(
  client: Pick<DeerdawnClient, 'getActiveContextByCwd'>,
  cwd: string,
  options: { tool?: string; nameTheGuess?: boolean } = {},
): Promise<WriteTarget> {
  const tool = options.tool || 'claude_code';
  // The same key the client sends with the request (it is cached there, so this
  // costs no second pair of git calls on the hook path).
  let workspaceKey: string | null = null;
  try { workspaceKey = workspaceKeyForCwd(cwd); } catch { workspaceKey = null; }
  let unreachable = false;
  const asked: ActiveMatch | null = await client
    .getActiveContextByCwd(cwd, tool, 'light', false, null, { purpose: 'write' })
    .catch(() => { unreachable = true; return null; });

  if (asked?.project_id && isWriteGradeMatch(asked, workspaceKey)) {
    return { kind: 'target', projectId: asked.project_id, projectName: asked.project_name ?? null };
  }

  const known = knownTargetFor(cwd);
  if (known) return { kind: 'target', ...known };

  if (asked?.project_id) {
    return { kind: 'guess', projectId: asked.project_id, projectName: asked.project_name ?? null, reason: guessReason(asked, workspaceKey) };
  }
  // Offline, the second request would only spend another timeout to learn the
  // same thing, in front of somebody who is waiting for an answer.
  if (!options.nameTheGuess || unreachable) return { kind: 'none' };

  const shown: ActiveMatch | null = await client
    .getActiveContextByCwd(cwd, tool, 'light')
    .catch(() => null);
  if (!shown?.project_id) return { kind: 'none' };
  // A read that comes back write-grade when the write request found nothing is
  // two requests disagreeing (a link landed in between, or a proxy dropped the
  // parameter). The second answer is as good as the first would have been.
  if (isWriteGradeMatch(shown, workspaceKey)) {
    return { kind: 'target', projectId: shown.project_id, projectName: shown.project_name ?? null };
  }
  return { kind: 'guess', projectId: shown.project_id, projectName: shown.project_name ?? null, reason: guessReason(shown, workspaceKey) };
}

// What to do with no project, naming only advertised tools. "Or run
// start_session first" was circular on a new account: start_session creates
// nothing, manage_projects(create) does. Same sentence as the hosted
// dispatcher's (apps/api/src/routes/mcp.js).
export const NO_PROJECT_NEXT_STEP = 'Pass project_id (recall(action:"projects") lists them), or, if there is no project yet, create one with manage_projects(action:"create", project_name:"<name>").';

/**
 * The sentence an explicit tool call returns instead of writing to a guess.
 * `purpose` reads as the rest of "No active project to …" / "… does not … a
 * guess", e.g. "record a finding in".
 */
export function describeWriteRefusal(target: Exclude<WriteTarget, { kind: 'target' }>, purpose: string): string {
  if (target.kind === 'none') {
    return `No active project to ${purpose}. ${NO_PROJECT_NEXT_STEP}`;
  }
  const label = target.projectName ? `"${target.projectName}" (${target.projectId})` : target.projectId;
  if (target.reason === 'folder_key') {
    return [
      `Nothing was saved. This repo has no git remote, so DeerDawn can only identify it by its folder name, and ${label} matched on that alone.`,
      `Any other folder with the same name matches it too, so DeerDawn does not ${purpose} it without being told.`,
      `If it IS the right project, repeat this call with project_id: "${target.projectId}". Otherwise pass the right project_id, or run start_session to see what this directory resolves to.`,
    ].join(' ');
  }
  const how = target.reason === 'name'
    ? 'only because its name contains this folder\'s name'
    : target.reason === 'recency'
      ? 'only because it is the most recently used project'
      : target.reason === 'parent_folder'
        ? 'only because a parent folder of this directory is linked to it, and this directory is another or unknown repository'
        : 'on a signal too weak to file a write under';
  return [
    `Nothing was saved. No project is linked to this directory, and the closest match, ${label}, matched ${how}.`,
    `That is a guess, and DeerDawn does not ${purpose} a guess: a write filed into the wrong project cannot be undone from here.`,
    `If it IS the right project, repeat this call with project_id: "${target.projectId}". Otherwise pass the right project_id, or run start_session to see what this directory resolves to.`,
  ].join(' ');
}
