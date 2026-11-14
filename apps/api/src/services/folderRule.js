'use strict';

/**
 * THE FOLDER RULE. One place that says which project a directory belongs to.
 *
 * Two things used to answer that question with different rules: the resolver
 * (contextSyncService.resolveActiveProject: which project a session or an
 * explicit write belongs to) and capture (extractionService: where the
 * end-of-session extraction is filed, and contextSyncService.applyExtraction:
 * which project a proposed name may be merged into). Both now read the same
 * claim from here, so they cannot disagree about a folder. The rule is the
 * owner's decision (journey round 3, design A):
 *
 *   A project OWNS a directory when
 *     - the directory IS one of its linked paths, or
 *     - it is BELOW a linked path of a project whose repository identity
 *       (workspace_key: `remote:<origin>`, else `root:<folder name>`) is known
 *       on both sides and equal.
 *   A project whose repository identity matches and that has no linked path
 *   also owns it (the same repository, however the person got there).
 *
 *   A linked path that sits ABOVE the directory in a different repository, or
 *   where only one side's repository is known (a home folder, a workspace
 *   parent, a git repository inside a plain folder), does not own it. It is a
 *   guess: the project may be READ, with a warning, and is NEVER written to.
 *
 *   A project whose NAME resembles the folder's name is a guess too, and a
 *   capture is never merged into a project by name alone.
 *
 * Pure: no database, no request. Callers pass the candidates they already hold.
 */

// The kinds a folder claim can have, strongest first. 'path' and 'workspace'
// are the two that OWN the folder; the rest are guesses. The strings are the
// resolver's match_kind values, so they travel to the tools unchanged.
const CLAIM = Object.freeze({
  PATH: 'path',
  WORKSPACE: 'workspace',
  ANCESTOR: 'ancestor_path',
  NAME: 'name',
  NONE: 'recency_fallback',
});

// What a person and an assistant are told when a project is shown only because
// a parent folder of this directory is linked to it.
const ANCESTOR_WARNING = 'this folder is inside a folder linked to this project, but it is a different or unknown repository, so it is shown for reading only: nothing from this folder is saved into it';

function normalizeFolder(value) {
  return String(value || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

function repositoryIdentity(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// A key that is only a folder name (`root:<name>`): two unrelated folders with
// the same name and no git remote share it. It can tie a directory that is
// already below a linked path, but it cannot own a folder on its own.
function isFolderNameKey(key) {
  return typeof key === 'string' && key.startsWith('root:');
}

function segmentCount(linked) {
  return linked.split('/').filter(Boolean).length;
}

/**
 * What one project's links say about one folder.
 *
 * `folder` is { cwd, workspaceKey }; either may be missing. Returns:
 *   kind        one of CLAIM
 *   matchedPath the deepest linked path that owns the folder (kind 'path')
 *   exact       the folder IS a linked path (not merely below one)
 *   ownDepth    depth, in path segments, of the deepest OWNING linked path, or
 *               -1 when none owns it
 *   ancestorDepth  same for a containing path that does not own it
 *   writable    may a write with no project named be filed here?
 *   warning     the sentence a READ of this guess carries, when it has one
 */
function folderClaim(project, folder = {}) {
  const cwd = normalizeFolder(folder.cwd);
  const identity = repositoryIdentity(folder.workspaceKey);
  const projectIdentity = repositoryIdentity(project?.workspace_key);
  const sameRepository = Boolean(identity) && projectIdentity === identity;
  // Neither side is a git repository: a plain folder below a plain linked folder.
  // Only a folder KNOWN to be another repository is not the linked project's.
  const bothUnknown = !identity && !projectIdentity;

  let ownDepth = -1;
  let ancestorDepth = -1;
  let matchedPath = null;
  let ancestorPath = null;
  let exact = false;
  if (cwd) {
    for (const linkedPath of project?.linked_paths || []) {
      const linked = normalizeFolder(linkedPath);
      if (!linked || !(cwd === linked || cwd.startsWith(`${linked}/`))) continue;
      const depth = segmentCount(linked);
      if (cwd === linked || sameRepository || bothUnknown) {
        if (cwd === linked) exact = true;
        if (depth > ownDepth) { ownDepth = depth; matchedPath = linked; }
      } else if (depth > ancestorDepth) {
        ancestorDepth = depth;
        ancestorPath = linked;
      }
    }
  }

  if (ownDepth >= 0) {
    return { kind: CLAIM.PATH, matchedPath, ownDepth, ancestorDepth, exact, writable: true, warning: null };
  }
  if (sameRepository) {
    return {
      kind: CLAIM.WORKSPACE,
      matchedPath: null,
      ownDepth,
      ancestorDepth,
      writable: !isFolderNameKey(identity),
      warning: null,
    };
  }
  if (ancestorDepth >= 0) {
    return { kind: CLAIM.ANCESTOR, matchedPath: ancestorPath, ownDepth, ancestorDepth, writable: false, warning: ANCESTOR_WARNING };
  }
  if (cwd) {
    const repoName = cwd.split('/').filter(Boolean).pop() || '';
    if (repoName && String(project?.project_name || '').toLowerCase().includes(repoName)) {
      return { kind: CLAIM.NAME, matchedPath: null, ownDepth, ancestorDepth, writable: false, warning: null };
    }
  }
  return { kind: CLAIM.NONE, matchedPath: null, ownDepth, ancestorDepth, writable: false, warning: null };
}

/**
 * How well a project fits a folder, for ranking candidates. The number the
 * resolver has always ranked by, with a containing path that does not own the
 * folder worth less than any real signal: it is a guess.
 */
function folderScore(project, folder = {}) {
  if (!project) return Number.NEGATIVE_INFINITY;
  const cwd = normalizeFolder(folder.cwd);
  const identity = repositoryIdentity(folder.workspaceKey);
  const claim = folderClaim(project, folder);
  let score = 0;
  if (cwd) {
    if (claim.ownDepth >= 0) {
      score += 1.1 + Math.min(0.8, claim.ownDepth * 0.06);
    } else if (claim.ancestorDepth >= 0) {
      // A guess, below every real signal and below a name match; the nearer
      // parent folder is the better guess.
      score += 0.25 + Math.min(0.15, claim.ancestorDepth * 0.01);
    } else if ((project.linked_paths || []).some((linked) => normalizeFolder(linked).startsWith(`${cwd}/`))) {
      // The folder is ABOVE a linked path (you are above the package): weak,
      // and never when a containing match exists.
      score += 0.2;
    }
    const repoName = cwd.split('/').filter(Boolean).pop() || '';
    if (repoName && String(project.project_name || '').toLowerCase().includes(repoName)) score += 0.45;
  }
  // The same repository: sibling work-streams of one codebase. Ranks above a
  // name match, below a precise linked-path match.
  if (identity && repositoryIdentity(project.workspace_key) === identity) score += 1.0;
  score += new Date(project.updated_at).getTime() / 1e13;
  return score;
}

/** Every candidate with its claim and score, best first. */
function rankProjectsForFolder(candidates, folder = {}) {
  return [...(candidates || [])]
    .map((project) => ({ project, claim: folderClaim(project, folder), score: folderScore(project, folder) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * The project a write from this folder belongs to, if the folder decides one.
 *
 * `pinnedProjectId` is the sub-project the person switched to for this
 * repository (the workspace pointer). It wins over location, exactly as it does
 * for start_session, and only inside the repository it was pinned for.
 *
 * Null when the folder owns no project: the caller creates one or asks, it does
 * not guess.
 */
function writeTargetForFolder(candidates, folder = {}, { pinnedProjectId = null } = {}) {
  const identity = repositoryIdentity(folder.workspaceKey);
  if (pinnedProjectId && identity) {
    const pinned = (candidates || []).find((project) => (
      project.project_id === pinnedProjectId && repositoryIdentity(project.workspace_key) === identity
    ));
    if (pinned) return { project: pinned, claim: { kind: 'pinned', matchedPath: null, writable: true, warning: null } };
  }
  const owner = rankProjectsForFolder(candidates, folder).find((entry) => entry.claim.writable);
  return owner ? { project: owner.project, claim: owner.claim } : null;
}

module.exports = {
  CLAIM,
  ANCESTOR_WARNING,
  normalizeFolder,
  repositoryIdentity,
  isFolderNameKey,
  folderClaim,
  folderScore,
  rankProjectsForFolder,
  writeTargetForFolder,
};
