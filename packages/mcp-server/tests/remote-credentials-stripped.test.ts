/**
 * The workspace key is derived from `remote.origin.url`, and people do keep
 * credentials in that URL. The key is sent to the API on every call, stored on
 * the project and published as a Trail's repo_url, so whatever survives
 * normalisation is disclosed.
 *
 * Asserted through the public functions against a real git repo, since that is
 * the only way the value is ever produced.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { getSourcePin, getWorkspaceKey } from '../src/freshness.js';

const made: string[] = [];

function repoWithRemote(remote: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-remote-')));
  made.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'remote.origin.url', remote], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('credentials in a git remote never reach the workspace key', () => {
  const PASSWORDS = ['p@ss' + 'w0rd', 'p@ss/' + 'w0rd', '@@' + 'tricky@@', 'plain' + 'Secret1'];

  for (const password of PASSWORDS) {
    it(`strips all of ${JSON.stringify(password)}`, () => {
      const dir = repoWithRemote(`https://ci-bot:${password}@github.com/Acme/Widgets.git`);
      const key = getWorkspaceKey(dir);
      expect(key).toBe('remote:github.com/acme/widgets');
      const pin = getSourcePin(dir);
      expect(pin.repo_url).toBe('https://github.com/acme/widgets');
      for (const fragment of [password.toLowerCase(), 'ci-bot', 'w0rd', 'tricky', 'secret1']) {
        expect(String(key)).not.toContain(fragment);
        expect(String(pin.repo_url)).not.toContain(fragment);
      }
    });
  }

  it('a local-path remote containing @ keeps its key (it has no userinfo to strip)', () => {
    expect(getWorkspaceKey(repoWithRemote('/srv/git/team@work/widgets.git'))).toBe('remote:/srv/git/team@work/widgets');
    expect(getWorkspaceKey(repoWithRemote('file:///srv/git/team@work/widgets.git'))).toBe('remote:/srv/git/team@work/widgets');
    expect(getWorkspaceKey(repoWithRemote('deploy@git.internal:team/widgets.git'))).toBe('remote:git.internal:team/widgets');
  });

  it('every ordinary remote spelling still maps to the same key as before', () => {
    const same = [
      'https://github.com/Acme/Widgets.git',
      'https://github.com/Acme/Widgets',
      'git@github.com:Acme/Widgets.git',
      'ssh://git@github.com/Acme/Widgets.git',
      'https://token@github.com/Acme/Widgets.git',
      'https://acme@dev.azure.com/Acme/Widgets',
    ];
    const keys = same.map((remote) => getWorkspaceKey(repoWithRemote(remote)));
    expect(keys.slice(0, 5)).toEqual(Array(5).fill('remote:github.com/acme/widgets'));
    expect(keys[5]).toBe('remote:dev.azure.com/acme/widgets');
  });
});
