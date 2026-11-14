/**
 * What the SessionStart hook says about WHICH project it loaded.
 *
 * The failure this pins: a session in repo A opened project B (a connector with
 * no view of the folder guessed from recent history), nothing said it was a
 * guess, and the agent worked from B's brief. A confident answer now hands over
 * its id; a guess says so, names the alternatives, and says how to switch; and
 * the last confident answer per directory survives an outage. A guess is never
 * remembered.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  routingFrame, noMatchHint, alternativesLine, rememberRepoProject, lastKnownRepoProject, lastKnownHint, isGuess,
} from '../src/routing-hint.js';

describe('routingFrame', () => {
  it('a confident match keeps "use it without re-asking" and hands over the project id', () => {
    const { header, footer } = routingFrame(
      { project_id: 'proj_a', project_name: 'Alpha', match_kind: 'path', match_confidence: 'high', write_target: true },
      ' (synced 2026-10-14)',
    );
    expect(header).toContain('Project context — Alpha (synced 2026-10-14)');
    expect(header).toContain('this directory is linked to it');
    expect(header).toContain('use it without re-asking');
    expect(footer).toContain('project_id: "proj_a"');
  });

  it('a guess says it is a guess, never promises it, and names the way out', () => {
    const { header, footer } = routingFrame(
      {
        project_id: 'proj_b', project_name: 'Beta', match_kind: 'name', match_confidence: 'low', write_target: false,
        alternatives: [{ project_id: 'proj_c', project_name: 'Gamma' }, { project_id: 'proj_d', project_name: null }],
      },
      '',
    );
    expect(header).toContain('POSSIBLE project context — "Beta" (proj_b)');
    expect(header).toContain('This is a guess');
    expect(header).not.toContain('without re-asking');
    expect(header).toContain('"Gamma" (proj_c)');
    expect(header).toContain('"proj_d"');
    expect(header).toContain('manage_projects (action "select")');
    expect(footer).toBe('');
  });

  it('match_guessed alone marks a guess, even with a high-confidence kind', () => {
    expect(isGuess({ project_id: 'p', match_kind: 'session', match_confidence: 'high', match_guessed: true })).toBe(true);
    expect(isGuess({ project_id: 'p', match_kind: 'session', match_confidence: 'high', match_guessed: false })).toBe(false);
  });
});

describe('noMatchHint / alternativesLine', () => {
  it('says nothing when there is nothing to offer', () => {
    expect(noMatchHint([])).toBeNull();
    expect(noMatchHint(null)).toBeNull();
    expect(alternativesLine([{ project_id: '' }])).toBeNull();
  });

  it('caps the list at three', () => {
    const line = alternativesLine([1, 2, 3, 4].map((n) => ({ project_id: `p${n}`, project_name: `P${n}` })));
    expect(line).toContain('"P3" (p3)');
    expect(line).not.toContain('p4');
  });
});

describe('per-directory cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-routing-cache-'));
    process.env.DEERDAWN_DIR = dir;
  });
  afterEach(() => {
    delete process.env.DEERDAWN_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('remembers a confident answer and offers it during an outage', () => {
    rememberRepoProject('/repo/a', { project_id: 'proj_a', project_name: 'Alpha', match_kind: 'path', match_confidence: 'high' });
    const entry = lastKnownRepoProject('/repo/a');
    expect(entry?.project_id).toBe('proj_a');
    expect(lastKnownHint(entry)).toContain('project_id: "proj_a"');
    expect(lastKnownRepoProject('/repo/b')).toBeNull();
  });

  it('never remembers a guess, and a guess does not overwrite a confident answer', () => {
    rememberRepoProject('/repo/a', { project_id: 'proj_a', project_name: 'Alpha', match_kind: 'path', match_confidence: 'high' });
    rememberRepoProject('/repo/a', { project_id: 'proj_b', project_name: 'Beta', match_kind: 'name', match_confidence: 'low' });
    rememberRepoProject('/repo/c', { project_id: 'proj_b', project_name: 'Beta', match_kind: 'recency_fallback', match_guessed: true });
    expect(lastKnownRepoProject('/repo/a')?.project_id).toBe('proj_a');
    expect(lastKnownRepoProject('/repo/c')).toBeNull();
  });

  it('a corrupt cache file reads as empty and is replaced, never thrown', () => {
    fs.writeFileSync(path.join(dir, 'repo-projects.json'), '{not json');
    expect(lastKnownRepoProject('/repo/a')).toBeNull();
    rememberRepoProject('/repo/a', { project_id: 'proj_a', match_kind: 'path', match_confidence: 'high' });
    expect(lastKnownRepoProject('/repo/a')?.project_id).toBe('proj_a');
  });
});
