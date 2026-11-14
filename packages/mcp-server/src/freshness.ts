/**
 * freshness: honest staleness signals for resumed context.
 *
 * The product's trust problem is that it echoes recorded free-text claims
 * ("Current status: all tests pass") with a "just now" timestamp, even when the
 * working tree has moved on since those claims were written. This module derives
 * a divergence signal from git so the agent (and user) can tell "written
 * recently" apart from "still true".
 *
 * Self-contained on purpose — only node builtins. This runs inside the
 * latency-sensitive SessionStart hook, so it must not pull the client/auth/axios
 * dependency graph. The git calls are best-effort: any failure (not a repo, git
 * missing) degrades to "no signal", never throws.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type Freshness = {
  /** Uncommitted (incl. untracked) file count in the working tree. */
  uncommittedCount: number;
  /** Short HEAD SHA, or null outside a git repo. */
  headSha: string | null;
  /** Honest write-recency phrase, e.g. "written 3h ago" — never "active". */
  recency: string;
  /**
   * Non-null only when the tree has diverged from what the context describes
   * (uncommitted changes exist). A one-line warning to surface above the brief.
   */
  staleBadge: string | null;
};

function findGitRoot(startDir: string): string | null {
  let dir: string;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }
  // Bounded walk up the tree looking for a .git marker.
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function humanizeAge(ms: number): string {
  const m = ms / 60000;
  if (m < 1) return 'moments ago';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/**
 * Inspect the working tree at `cwd` and the recorded `lastUpdated` timestamp,
 * and return honest recency + a divergence badge (only when there are
 * uncommitted changes the recorded claims can't account for).
 */
export function computeFreshness(cwd: string, lastUpdated?: string | null): Freshness {
  const gitRoot = findGitRoot(cwd) || cwd;

  let uncommittedCount = 0;
  const status = git(['status', '--porcelain', '--untracked-files=all'], gitRoot);
  if (status != null) {
    uncommittedCount = status.split('\n').map((l) => l.trim()).filter(Boolean).length;
  }
  const headSha = git(['rev-parse', '--short', 'HEAD'], gitRoot) || null;

  let recency = 'write time unknown';
  if (lastUpdated) {
    const ms = Date.now() - new Date(lastUpdated).getTime();
    if (Number.isFinite(ms) && ms >= 0) recency = `written ${humanizeAge(ms)}`;
  }

  let staleBadge: string | null = null;
  if (uncommittedCount > 0) {
    const files = `${uncommittedCount} uncommitted file${uncommittedCount === 1 ? '' : 's'}`;
    // Confident-capability framing, not a warning: DeerDawn is actively tracking
    // that local work has moved on, rather than telling the user it might be wrong.
    staleBadge =
      `↻ ${files} changed since this context was ${recency} — ` +
      `I'll factor your latest local work in as we go.`;
  }

  return { uncommittedCount, headSha, recency, staleBadge };
}

/** Compact one-line recency suffix for headers, e.g. "written 3h ago · HEAD a1b2c3d". */
export function recencyLine(fresh: Freshness): string {
  return fresh.headSha ? `${fresh.recency} · HEAD ${fresh.headSha}` : fresh.recency;
}

/**
 * Normalize a git remote URL into a stable, clone-independent key, e.g.
 * `git@github.com:Org/Repo.git` and `https://github.com/Org/Repo.git` both
 * become `github.com/org/repo`.
 */
function normalizeRemote(url: string): string {
  let s = String(url).trim().toLowerCase();
  s = s.replace(/\.git$/, '');
  s = s.replace(/^git@([^:]+):/, '$1/'); // scp-style git@host:path -> host/path
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme (https://, ssh://)
  // Strip credentials from the LAST `@`, not the first. `[^@/]+@` stopped at the
  // first one, so `https://ci:p@ss/w0rd@github.com/org/repo` kept everything
  // after it — `ss/w0rd@github.com/org/repo` — and that string is the workspace
  // key: sent to the API on every call, stored on the project, and published as
  // a Trail's repo_url. A password may hold `@` and `/` (git accepts both raw),
  // so the only `@` that can be trusted to precede the host is the final one. A
  // repo PATH containing `@` would be cut short by this; no forge allows one in
  // an owner or repository name, and a wrong key is the cheaper failure.
  //
  // Only a URL has userinfo to strip. A remote that is a local path
  // (`/srv/git/team@work/repo.git`, `file:///...`) keeps its `@`: cutting it
  // would re-key every project already grouped under that path.
  const at = s.lastIndexOf('@');
  if (hadScheme && !s.startsWith('/') && at !== -1) s = s.slice(at + 1);
  else if (!hadScheme) s = s.replace(/^[^@/]+@/, ''); // scp-style user@host:path
  return s.replace(/\/+$/, '');
}

/**
 * Stable workspace identity for the repo at `cwd` — used to group projects that
 * share a codebase into one workspace (sibling work-streams) instead of N peers.
 * Prefers the git remote (stable across clones/machines); falls back to the git
 * root dir name for local-only repos. git-only and never-throws so it stays cheap
 * inside the SessionStart hook. Returns null outside a git repo.
 *
 * THE `root:` FORM IS NOT UNIQUE, AND IS KEPT ANYWAY. Two unrelated local-only
 * repos that are both called `app` share `root:app`. A collision-resistant form
 * was considered and not shipped from here: the server matches this key by
 * equality against what it already stored (on projects, and on subproject pins),
 * and one request carries one key, so changing the spelling would orphan every
 * project and pin already stored for every local-only repo. It has to be a
 * two-sided change. Until then the weakness is contained where it does harm:
 * write-target.ts does not accept a match reached through a `root:` key as a
 * place to write.
 */
export function getWorkspaceKey(cwd: string): string | null {
  const root = findGitRoot(cwd);
  if (!root) return null;
  const remote = git(['config', '--get', 'remote.origin.url'], root);
  if (remote) return `remote:${normalizeRemote(remote)}`;
  return `root:${path.basename(root).toLowerCase()}`;
}

/**
 * The source pin for a Trail export: which repo, which commit, which branch.
 *
 * A Trail claims to describe a codebase at a moment in time. Without a commit
 * SHA that claim cannot be checked and the freshness work (behind-by-N) has no
 * baseline — so this reports what it actually found and never guesses. The full
 * 40-char SHA is used rather than the short form: a Trail can outlive the repo
 * growing enough to make a 7-char prefix ambiguous.
 *
 * `dirty` matters more than it looks. Exporting from a tree with uncommitted
 * changes produces a Trail describing code that exists only on one machine, so
 * the pin is recorded but flagged rather than silently trusted.
 */
export function getSourcePin(cwd: string): {
  repo_url: string | null;
  commit_sha: string | null;
  branch: string | null;
  dirty: boolean;
} {
  const root = findGitRoot(cwd);
  if (!root) return { repo_url: null, commit_sha: null, branch: null, dirty: false };
  const remote = git(['config', '--get', 'remote.origin.url'], root);
  const status = git(['status', '--porcelain', '--untracked-files=no'], root);
  return {
    repo_url: remote ? `https://${normalizeRemote(remote)}` : null,
    commit_sha: git(['rev-parse', 'HEAD'], root),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    dirty: Boolean(status && status.trim()),
  };
}

/**
 * For each anchored finding commit, report whether it is still in HEAD's ancestry.
 * A finding whose fix-commit was rebased/squashed away is no longer replayable and
 * should be re-verified rather than trusted. git-only, never-throws, bounded to a
 * few refs (each check is a subprocess inside the latency-sensitive hook). Returns
 * a map ref->true|false; refs git can't resolve are omitted (unknown, not "gone").
 */
export function checkCommitsInHead(cwd: string, refs: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot || !Array.isArray(refs)) return out;
  for (const ref of refs.slice(0, 5)) {
    const r = String(ref || '').trim();
    if (!r) continue;
    // Only classify refs git actually knows about; an unknown ref is "unknown",
    // not "rebased away" (avoid false re-verify nags on shallow clones).
    if (git(['cat-file', '-e', `${r}^{commit}`], gitRoot) === null) continue;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', r, 'HEAD'], {
        cwd: gitRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      out[r] = true; // exit 0 → ancestor of HEAD
    } catch {
      out[r] = false; // non-zero → not in current history
    }
  }
  return out;
}
