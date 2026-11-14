/**
 * git blame → who actually wrote each fact in a CLAUDE.md.
 *
 * WHY. A brand-new team workspace is empty, so the first member's brief has
 * nothing in it and the premise ("your agent already knows what the team knows")
 * dies on contact. Seeding from the repo's own CLAUDE.md / AGENTS.md fixes the
 * emptiness — but imported anonymously it produces a wall of unattributed
 * claims, and a claim with no author cannot be trusted, chased, or retired. The
 * repo already knows who wrote every line. This reads that.
 *
 * TWO RULES, neither negotiable:
 *
 *   1. FAIL OPEN. No git, not a repo, a file git has never seen, a slow
 *      filesystem — every one of those returns "no attribution" and the import
 *      proceeds exactly as it did before. Attribution is a bonus on top of a
 *      seed; it must never be the reason somebody's context did not import.
 *   2. NEVER INVENT AN AUTHOR. A git email that matches nobody in the workspace
 *      resolves to null, which already means "belongs to the workspace". An
 *      ex-colleague's commits must not conjure a member, and a null renders as
 *      unattributed rather than silently as the reader.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface BlameLine {
  email: string;
  name: string;
}

/** Bounded so a pathological repo cannot stall a session start. */
const BLAME_TIMEOUT_MS = 4000;
const MAX_BLAMED_BYTES = 512 * 1024;

/**
 * Blame a file, one entry per line (1-indexed).
 *
 * Returns an empty map on ANY failure. `--line-porcelain` repeats the author
 * headers for every line, which costs a little output and removes the need to
 * track commit state across the stream — worth it for a parser that must not be
 * subtly wrong about which line belongs to whom.
 */
export function blameFile(cwd: string, filePath: string): Map<number, BlameLine> {
  const blame = new Map<number, BlameLine>();
  try {
    const absolute = path.resolve(cwd, filePath);
    // `--` separates paths from options, so a filename that begins with a dash
    // cannot be read by git as a flag.
    const output = execFileSync(
      'git',
      ['blame', '--line-porcelain', '--', absolute],
      {
        cwd,
        timeout: BLAME_TIMEOUT_MS,
        maxBuffer: MAX_BLAMED_BYTES * 4,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    let line = 0;
    let name = '';
    let email = '';
    for (const raw of output.split('\n')) {
      if (/^[0-9a-f]{40} \d+ (\d+)/.test(raw)) {
        // Header: <sha> <orig-line> <final-line> [<count>]. The FINAL line
        // number is the one that indexes the file as it stands today.
        const parts = raw.split(' ');
        line = Number(parts[2]) || 0;
        name = '';
        email = '';
      } else if (raw.startsWith('author ')) {
        name = raw.slice(7).trim();
      } else if (raw.startsWith('author-mail ')) {
        email = raw.slice(12).trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
      } else if (raw.startsWith('\t')) {
        // The tab-prefixed line is the content, which closes the record.
        if (line > 0 && email && !isNonAuthor(email)) blame.set(line, { email, name });
        line = 0;
      }
    }
  } catch {
    // No git, not a repo, untracked file, timeout — all the same answer.
    return new Map();
  }
  return blame;
}

/**
 * Emails git produces for lines nobody committed. `not.committed.yet` is git's
 * own placeholder for uncommitted working-tree changes; attributing a fact to it
 * would put a fake address in a brief.
 */
function isNonAuthor(email: string): boolean {
  return !email || email.includes('not.committed.yet') || !email.includes('@');
}

/** Comparable form: case and punctuation vary, the words do not. */
function normalize(text: string): string {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Which line did this fact come from?
 *
 * The structured parser derives entries from lines but does not keep the line
 * number, so the text is matched back. An exact containment match is required —
 * a fuzzy one would attribute a fact to whoever happened to write a nearby line,
 * and a confidently wrong author is worse than no author at all.
 */
function findSourceLine(lines: string[], summary: string): number | null {
  const needle = normalize(summary);
  if (needle.length < 12) return null; // too short to match uniquely
  for (let i = 0; i < lines.length; i += 1) {
    if (normalize(lines[i]).includes(needle)) return i + 1;
  }
  return null;
}

/**
 * Stamp `author_email` onto every entry whose source line can be identified.
 *
 * Entries are returned unchanged when the line cannot be found or has no blame —
 * this only ever ADDS attribution, and an entry it cannot place keeps travelling
 * as it would have.
 */
export function attributeByBlame<T extends { summary?: string }>(
  content: string,
  entries: T[],
  blame: Map<number, BlameLine>,
): Array<T & { author_email?: string }> {
  if (!Array.isArray(entries) || !entries.length || !blame.size) return entries || [];
  const lines = content.split('\n');
  return entries.map((entry) => {
    if (!entry?.summary) return entry;
    const lineNumber = findSourceLine(lines, entry.summary);
    if (lineNumber === null) return entry;
    const author = blame.get(lineNumber);
    if (!author) return entry;
    return { ...entry, author_email: author.email };
  });
}

/**
 * Everyone the file's history credits, most lines first.
 *
 * Used to tell an admin what a seeded import will carry ("attributed to 4 people
 * from git history") before they commit to it, so the attribution is something
 * they accepted rather than something that happened to them.
 */
export function blameContributors(blame: Map<number, BlameLine>): Array<{ email: string; name: string; lines: number }> {
  const counts = new Map<string, { email: string; name: string; lines: number }>();
  for (const author of blame.values()) {
    const existing = counts.get(author.email);
    if (existing) existing.lines += 1;
    else counts.set(author.email, { email: author.email, name: author.name, lines: 1 });
  }
  return [...counts.values()].sort((a, b) => b.lines - a.lines);
}
