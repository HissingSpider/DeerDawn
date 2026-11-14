// What `setup` reads from a repo to build its first brief, and the Codex block
// it offers to add to that repo. Kept out of index.ts, which dispatches the CLI
// as an import side effect and so cannot be imported by a test.
//
// Both are ASKED first, in the terminal (setup-prompt.ts), with the files named
// before anything is read for sending. The local first session used to build a
// project from a build manifest and tell the model to read the README and the
// last 20 commits "without stopping to ask"; now it asks unless the person said
// yes here (setup-choices.ts `repo_seed`). With no terminal there is nobody to
// ask, and the answer is no.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { findLocalContextFile, readUserAuthoredContext } from './first-run-import.js';
import { findGitRoot, isLocationMatch } from './project-sync.js';
import { rememberWriteTarget } from './write-target.js';
import { redactSecrets } from './redact.js';
import { safeWriteFileSync } from './utils/safe-fs.js';

const README_NAMES = ['README.md', 'README', 'readme.md', 'README.markdown', 'README.txt'];
/** How much of the README is sent. The opening of a README is the part that says what the project is. */
export const README_SEND_CHARS = 4000;
const COMMIT_COUNT = 20;

export type RepoSeedPreview = {
  root: string;
  contextFile: { name: string; path: string; chars: number } | null;
  readme: { name: string; path: string; chars: number } | null;
  commits: string[];
};

function readReadme(root: string): { name: string; path: string; text: string } | null {
  for (const name of README_NAMES) {
    const file = path.join(root, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return { name, path: file, text };
    } catch { /* not this one */ }
  }
  return null;
}

function recentCommitSubjects(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'log', `-${COMMIT_COUNT}`, '--format=%s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return out.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, COMMIT_COUNT);
  } catch {
    return [];
  }
}

/** What a seed of this folder would read. Reads to measure; sends nothing. */
export function previewRepoSeed(cwd: string): RepoSeedPreview {
  const root = findGitRoot(cwd) || cwd;
  const local = findLocalContextFile(root);
  const contextText = local ? readUserAuthoredContext(local.path) : null;
  const readme = readReadme(root);
  return {
    root,
    contextFile: local && contextText ? { name: local.name, path: local.path, chars: contextText.length } : null,
    readme: readme ? { name: readme.name, path: readme.path, chars: readme.text.length } : null,
    commits: recentCommitSubjects(root),
  };
}

export function hasAnythingToSeed(preview: RepoSeedPreview): boolean {
  return Boolean(preview.contextFile || preview.readme || preview.commits.length);
}

/** The preview the person is shown before they are asked. */
export function describeRepoSeedPreview(preview: RepoSeedPreview): string[] {
  const lines: string[] = [];
  if (preview.contextFile) lines.push(`     ${preview.contextFile.name} (${preview.contextFile.chars.toLocaleString('en-US')} characters)`);
  if (preview.readme) {
    const sent = Math.min(preview.readme.chars, README_SEND_CHARS);
    lines.push(`     ${preview.readme.name} (${sent < preview.readme.chars ? `the first ${sent.toLocaleString('en-US')} of ` : ''}${preview.readme.chars.toLocaleString('en-US')} characters)`);
  }
  if (preview.commits.length) lines.push(`     the last ${preview.commits.length} commit subjects (git log), for example: "${preview.commits[0].slice(0, 60)}"`);
  return lines;
}

/** README opening and commit subjects as one text for extraction; secrets masked. null when there is neither. */
export function buildRepoSeedText(preview: RepoSeedPreview, options: { includeReadme?: boolean } = {}): string | null {
  const parts: string[] = [];
  if (options.includeReadme !== false && preview.readme) {
    try {
      const text = fs.readFileSync(preview.readme.path, 'utf8').trim().slice(0, README_SEND_CHARS);
      if (text) parts.push(`Project README (opening, from ${preview.readme.name}):\n${text}`);
    } catch { /* unreadable now: left out */ }
  }
  if (preview.commits.length) {
    parts.push(`Last ${preview.commits.length} commit subjects, newest first:\n${preview.commits.map((c) => `- ${c}`).join('\n')}`);
  }
  if (!parts.length) return null;
  return redactSecrets(`First brief for this repository, from its own files (set up with DeerDawn setup).\n\n${parts.join('\n\n')}`);
}

type SeedClient = {
  getActiveContextByCwd(cwd: string, tool?: string, verbosity?: string): Promise<any>;
  createContextProject(name: string, description?: string, parent?: string, options?: { cwd?: string }): Promise<any>;
  pushContextUpdate(projectId: string, summary: string, tool?: string): Promise<any>;
};

/**
 * Build the first brief, after a yes. The context file goes through the same
 * import start_session uses (structured, masked, never over an existing brief);
 * the README opening and commit subjects go to extraction on a project that is
 * this repo's (found by location, or created for it now). With a context file
 * imported, only the commit subjects are added: the file already said what the
 * project is.
 */
export async function seedRepoBrief(
  client: SeedClient,
  cwd: string,
  preview: RepoSeedPreview,
  importContextFile: () => Promise<string | null>,
): Promise<{ projectId: string | null; projectName: string | null; notes: string[] }> {
  const notes: string[] = [];
  let imported = false;
  if (preview.contextFile) {
    try {
      const text = await importContextFile();
      imported = Boolean(text);
      if (imported) notes.push(`imported ${preview.contextFile.name}`);
    } catch { /* falls through to the README and commits */ }
  }

  let projectId: string | null = null;
  let projectName: string | null = null;
  try {
    const active = await client.getActiveContextByCwd(cwd, 'claude_code', 'standard');
    if (active?.project_id && isLocationMatch(active.match_kind)) {
      projectId = active.project_id;
      projectName = active.project_name ?? null;
    }
  } catch { /* unknown: a project is created below */ }
  if (!projectId) {
    const name = path.basename(preview.root) || 'My Project';
    const created = await client.createContextProject(name, `Started by DeerDawn setup in ${name}`, undefined, { cwd });
    projectId = created?.project?.project_id ?? null;
    projectName = created?.project?.project_name ?? name;
    if (projectId) {
      rememberWriteTarget(cwd, projectId, projectName);
      notes.push(`created project "${projectName}"`);
    }
  }
  if (!projectId) return { projectId: null, projectName: null, notes };

  const text = buildRepoSeedText(preview, { includeReadme: !imported });
  if (text) {
    await client.pushContextUpdate(projectId, text, 'claude_code');
    notes.push(imported ? 'sent the commit subjects' : 'sent the README opening and commit subjects');
  }
  return { projectId, projectName, notes };
}

// ── The Codex block (Part III §3 of the activation plan) ─────────────────────

export const CODEX_BLOCK_HEADING = '## Project memory (DeerDawn)';

/** The block, filled with this project. The person's repo file, so their words, not a standing order. */
export function buildCodexAgentsBlock(projectName: string, projectId: string): string {
  const name = projectName.replace(/["\r\n]/g, ' ').trim();
  return [
    CODEX_BLOCK_HEADING,
    'At the start of a task in this repo, load the brief for DeerDawn project',
    `"${name}" (start_session, project_id "${projectId}") and use it as context. When you finish a task, save any`,
    'decision and the next step with DeerDawn (manage_memory, action "update").',
    'If DeerDawn is not connected, carry on without it.',
  ].join('\n');
}

/**
 * Add the block to the REPO's AGENTS.md (never a global file). Appended after
 * whatever is there; a file that already has the heading is left alone.
 */
export function writeCodexAgentsBlock(root: string, block: string): 'written' | 'already' | 'refused' {
  const file = path.join(root, 'AGENTS.md');
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  if (existing.includes(CODEX_BLOCK_HEADING)) return 'already';
  const next = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
  try {
    return safeWriteFileSync(file, next, 'utf8', root) ? 'written' : 'refused';
  } catch {
    return 'refused';
  }
}
