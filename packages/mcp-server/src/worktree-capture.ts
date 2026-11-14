import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DeerdawnClient } from './client.js';
import { findGitRoot } from './project-sync.js';
import { resolveHookApiKey } from './hook-api-key.js';
import { loadConfig } from './config.js';
import { safeWriteFileSync } from './utils/safe-fs.js';
import { isCaptureDisabled } from './capture-optout.js';
import { resolveWriteTarget } from './write-target.js';

type SnapshotState = {
  cwd: string;
  git_root: string;
  files: string[];
  updated_at: string;
  /** Fingerprint of the change set the last file_changed event described. */
  last_event_hash?: string;
};

function deerdawnHome(): string {
  if (process.env.DEERDAWN_DIR) return process.env.DEERDAWN_DIR;
  const home = process.env.DEERDAWN_HOME_DIR || os.homedir();
  return path.join(home, '.deerdawn');
}

function snapshotsDir(): string {
  return path.join(deerdawnHome(), 'worktree-snapshots');
}

function snapshotFileFor(cwd: string): string {
  const root = findGitRoot(cwd) || cwd;
  const key = Buffer.from(path.resolve(root)).toString('base64url');
  return path.join(snapshotsDir(), `${key}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function parseGitStatusPorcelain(raw: string): string[] {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const payload = line.slice(3).trim();
      if (payload.includes(' -> ')) {
        return payload.split(' -> ').pop() || payload;
      }
      return payload;
    })
    .filter(Boolean)
    .map((value) => value.replace(/\\/g, '/'));
}

export function diffChangedPaths(previous: string[] = [], current: string[] = []) {
  const previousSet = new Set((previous || []).map((value) => String(value || '').replace(/\\/g, '/')));
  return (current || []).filter((value) => !previousSet.has(String(value || '').replace(/\\/g, '/')));
}

export function readSnapshot(cwd: string): SnapshotState | null {
  try {
    return JSON.parse(fs.readFileSync(snapshotFileFor(cwd), 'utf8')) as SnapshotState;
  } catch {
    return null;
  }
}

export function writeSnapshot(cwd: string, files: string[], lastEventHash?: string): SnapshotState {
  const gitRoot = findGitRoot(cwd) || cwd;
  // Carried forward unless a new one is given. prime-worktree rewrites this file
  // at every SessionStart, and dropping the fingerprint there would make the
  // first hook of each session re-announce a change set that was already sent.
  const carried = lastEventHash ?? readSnapshot(cwd)?.last_event_hash;
  const snapshot: SnapshotState = {
    cwd: path.resolve(cwd),
    git_root: path.resolve(gitRoot),
    files: Array.from(new Set((files || []).map((value) => String(value || '').replace(/\\/g, '/')))).sort(),
    updated_at: nowIso(),
    ...(carried ? { last_event_hash: carried } : {}),
  };
  fs.mkdirSync(snapshotsDir(), { recursive: true });
  safeWriteFileSync(snapshotFileFor(cwd), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

// How many changed files are stat-ed for the fingerprint. Past this the names
// alone are hashed: a tree with thousands of dirty files is a generated-output
// directory, and a hook must not spend its budget stat-ing it.
const FINGERPRINT_STAT_LIMIT = 500;

/**
 * A fingerprint of "what is changed in this worktree right now".
 *
 * The hook runs after every edit AND at every Stop. When a run found no path
 * that was new since the last snapshot it fell back to reporting every dirty
 * file again, so a session that touched three files and then talked for twenty
 * turns recorded the same three-file event twenty more times.
 *
 * Names alone would be too coarse — a further edit to an already-dirty file IS
 * new — so each file's size and mtime go in too. Same names, same sizes, same
 * mtimes: nothing happened, and nothing is sent.
 */
export function changeSetFingerprint(gitRoot: string, files: string[]): string {
  const hash = createHash('sha256');
  const sorted = Array.from(new Set(files)).sort();
  sorted.forEach((file, index) => {
    hash.update(file);
    if (index < FINGERPRINT_STAT_LIMIT) {
      try {
        const stat = fs.statSync(path.join(gitRoot, file));
        hash.update(`:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      } catch {
        hash.update(':gone'); // deleted, which is itself a state
      }
    }
    hash.update('\n');
  });
  return hash.digest('hex').slice(0, 32);
}

export function getChangedFiles(cwd: string): string[] {
  const gitRoot = findGitRoot(cwd) || cwd;
  try {
    const raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return parseGitStatusPorcelain(raw);
  } catch {
    return [];
  }
}

// Short HEAD SHA at the given cwd, used to anchor debugging findings to a commit
// so they're replayable later. Returns null outside a git repo.
export function getHeadSha(cwd: string): string | null {
  const gitRoot = findGitRoot(cwd) || cwd;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export function buildFileChangeSummary(projectName: string, changedPaths: string[]): string {
  const sample = changedPaths.slice(0, 5);
  const remainder = changedPaths.length - sample.length;
  const suffix = remainder > 0 ? ` (+${remainder} more)` : '';
  return `Detected file changes for ${projectName}: ${sample.join(', ')}${suffix}`;
}

export function primeWorktreeSnapshot(cwd: string): SnapshotState {
  const files = getChangedFiles(cwd);
  return writeSnapshot(cwd, files);
}

export async function captureWorktreeChangeWithClient(
  client: Pick<DeerdawnClient, 'getActiveContextByCwd' | 'recordContextEvent'>,
  cwd: string,
  surface: 'claude_code' | 'codex' = 'claude_code'
): Promise<{ recorded: boolean; changed_paths: string[]; project_id: string | null }> {
  // Decided BEFORE the network call: a hook with nothing new to say should not
  // cost a request to find out which project it has nothing to say about.
  const gitRoot = findGitRoot(cwd) || cwd;
  const previous = readSnapshot(cwd);
  const currentFiles = getChangedFiles(cwd);
  const fingerprint = currentFiles.length ? changeSetFingerprint(gitRoot, currentFiles) : '';
  if (fingerprint && previous?.last_event_hash === fingerprint) {
    return { recorded: false, changed_paths: [], project_id: null };
  }

  // A write target, not "whatever /active says" — see write-target.ts. A name
  // guess used to receive a file_changed event on every edit, from a hook nobody
  // watches. With no real target the change set is dropped exactly as it is for
  // a directory with no project at all.
  const target = await resolveWriteTarget(client, cwd);
  const active = target.kind === 'target'
    ? { project_id: target.projectId, project_name: target.projectName }
    : null;
  if (!active?.project_id || !active?.project_name) {
    // No fingerprint stored: nothing was sent, so if this directory is linked to
    // a project later the same change set is still news.
    writeSnapshot(cwd, currentFiles);
    return { recorded: false, changed_paths: [], project_id: null };
  }

  const newPaths = diffChangedPaths(previous?.files || [], currentFiles);
  writeSnapshot(cwd, currentFiles, fingerprint || undefined);

  const changedPaths = newPaths.length ? newPaths : currentFiles;
  if (!changedPaths.length) {
    return { recorded: false, changed_paths: [], project_id: active.project_id };
  }

  let diffStat: string | null = null;
  try {
    const raw = execFileSync('git', ['diff', '--stat', '--no-color'], {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    // Take only the summary line e.g. "3 files changed, 47 insertions(+), 12 deletions(-)"
    const lines = raw.split('\n').filter(Boolean);
    diffStat = lines[lines.length - 1] || null;
  } catch { /* non-fatal */ }

  await client.recordContextEvent({
    event_type: 'file_changed',
    project_id: active.project_id,
    summary: buildFileChangeSummary(active.project_name, changedPaths),
    metadata: {
      surface,
      cwd,
      git_root: gitRoot,
      paths: changedPaths.slice(0, 25),
      change_count: changedPaths.length,
      ...(diffStat ? { diff_stat: diffStat } : {}),
    },
  }).catch(() => null);

  return {
    recorded: true,
    changed_paths: changedPaths,
    project_id: active.project_id,
  };
}

export async function captureWorktreeChange(surface: 'claude_code' | 'codex' = 'claude_code') {
  if (isCaptureDisabled()) return { recorded: false, changed_paths: [], project_id: null };
  // This repo's key, not the first one saved: see hook-api-key.ts. A Codex
  // surface has no Claude Code registration to read.
  const apiKey = resolveHookApiKey({ claudeConfig: surface !== 'codex' }).apiKey;
  if (!apiKey) return { recorded: false, changed_paths: [], project_id: null };
  const { DeerdawnClient: Client, HOOK_CLIENT_OPTIONS } = await import('./client.js');
  const client = new Client({ ...loadConfig(), apiKey }, HOOK_CLIENT_OPTIONS);
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return captureWorktreeChangeWithClient(client, cwd, surface);
}
