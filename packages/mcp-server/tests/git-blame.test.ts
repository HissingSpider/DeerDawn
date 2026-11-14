import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blameFile, attributeByBlame, blameContributors } from '../src/git-blame.js';

/**
 * Attribution from git history.
 *
 * Built against a real throwaway repo rather than a mocked git, because the
 * thing most likely to be wrong here is the porcelain parsing — and a mock would
 * be written from the same misreading as the parser.
 */

let repo: string;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-blame-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'sarah@acme.com'], repo);
  git(['config', 'user.name', 'Sarah'], repo);
  // Trailing newline matters: without it, appending later MODIFIES this last
  // line, and git then correctly credits the second author with it — which would
  // look like a parser bug and is really a fixture bug.
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), [
    '# Project',
    '',
    '## Recent decisions',
    '- Retry the payments webhook on a 429 response',
    '',
  ].join('\n'));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'sarah'], repo);

  git(['config', 'user.email', 'marcus@acme.com'], repo);
  git(['config', 'user.name', 'Marcus'], repo);
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '- Move session storage out of memory and into Redis\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'marcus'], repo);
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('blameFile', () => {
  it('attributes each line to whoever committed it', () => {
    const blame = blameFile(repo, 'CLAUDE.md');
    expect(blame.size).toBeGreaterThan(0);
    const emails = new Set([...blame.values()].map((b) => b.email));
    expect(emails.has('sarah@acme.com')).toBe(true);
    expect(emails.has('marcus@acme.com')).toBe(true);
  });

  it('counts contributors, most lines first', () => {
    const contributors = blameContributors(blameFile(repo, 'CLAUDE.md'));
    expect(contributors.length).toBe(2);
    expect(contributors[0].lines).toBeGreaterThanOrEqual(contributors[1].lines);
  });

  // Attribution is a bonus on top of a seed. It must never be the reason
  // somebody's context failed to import, so every failure is the same answer.
  it('fails open outside a repo', () => {
    expect(blameFile(os.tmpdir(), 'nothing-here.md').size).toBe(0);
  });

  it('fails open on a file git has never seen', () => {
    fs.writeFileSync(path.join(repo, 'untracked.md'), 'hello\n');
    expect(blameFile(repo, 'untracked.md').size).toBe(0);
  });

  it('fails open on a missing file', () => {
    expect(blameFile(repo, 'does-not-exist.md').size).toBe(0);
  });

  it('treats a dash-leading filename as a path, never as a flag', () => {
    // `--` separates paths from options; without it git would read this as one.
    expect(blameFile(repo, '--version').size).toBe(0);
  });
});

describe('attributeByBlame', () => {
  it('stamps the author of the line a fact came from', () => {
    const blame = blameFile(repo, 'CLAUDE.md');
    const content = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    const out = attributeByBlame(content, [
      { summary: 'Retry the payments webhook on a 429 response' },
      { summary: 'Move session storage out of memory and into Redis' },
    ], blame);
    expect(out[0].author_email).toBe('sarah@acme.com');
    expect(out[1].author_email).toBe('marcus@acme.com');
  });

  it('leaves an unplaceable entry alone rather than guessing', () => {
    // A confidently wrong author is worse than none: it credits somebody with a
    // claim they never made and sends the reader to the wrong person.
    const blame = blameFile(repo, 'CLAUDE.md');
    const content = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    const out = attributeByBlame(content, [{ summary: 'A decision that appears nowhere in this file' }], blame);
    expect(out[0].author_email).toBeUndefined();
  });

  it('will not match on a summary too short to be unique', () => {
    const blame = blameFile(repo, 'CLAUDE.md');
    const content = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(attributeByBlame(content, [{ summary: 'Retry' }], blame)[0].author_email).toBeUndefined();
  });

  it('returns entries untouched when there is no blame at all', () => {
    const entries = [{ summary: 'Retry the payments webhook on a 429 response' }];
    expect(attributeByBlame('irrelevant', entries, new Map())).toEqual(entries);
  });

  it('never throws on malformed input', () => {
    const blame = blameFile(repo, 'CLAUDE.md');
    expect(() => attributeByBlame('', [], blame)).not.toThrow();
    expect(() => attributeByBlame('x', [{}] as any, blame)).not.toThrow();
    expect(() => attributeByBlame('x', null as any, blame)).not.toThrow();
  });
});
