import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { hookKeySender, recordRejectedPinnedKey, resolveHookApiKey, resolveHookApiKeys } from '../src/hook-api-key.js';

/**
 * The resolution order a hook uses for its key — the unit half of
 * tests/hook-key-per-repo.node.test.cjs, for the cases that need no process.
 */
function scratch() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-hak-home-')));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-hak-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  return { home, repo };
}
const entry = (key: string) => ({ command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_KEY: key } });

describe('resolveHookApiKey', () => {
  it('expands ${VAR} in .mcp.json the way Claude Code does, and skips an empty expansion', () => {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: entry('${TEAM_DD_KEY}') } }));
    expect(resolveHookApiKey({ projectDir: repo, home, env: { TEAM_DD_KEY: 'dd_team_expanded' } }))
      .toEqual({ apiKey: 'dd_team_expanded', source: 'project-config' });
    // Unset variable: not the literal "${TEAM_DD_KEY}", and not an empty key.
    expect(resolveHookApiKey({ projectDir: repo, home, env: {} })).toEqual({ apiKey: null, source: null });
    expect(resolveHookApiKey({ projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } }).apiKey).toBe('dd_shell');
  });

  it('honours ${VAR:-default}', () => {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: entry('${NOPE:-dd_default_key}') } }));
    expect(resolveHookApiKey({ projectDir: repo, home, env: {} }).apiKey).toBe('dd_default_key');
  });

  it('reads a user-scope registration before the shell and the saved key', () => {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_user_scope') } }));
    fs.mkdirSync(path.join(home, '.deerdawn'));
    fs.writeFileSync(path.join(home, '.deerdawn', 'credentials.json'), JSON.stringify({ api_key: 'dd_saved' }));
    expect(resolveHookApiKey({ projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } }))
      .toEqual({ apiKey: 'dd_user_scope', source: 'user-config' });
  });

  it('does not adopt a .mcp.json above the repo root', () => {
    const { home, repo } = scratch();
    const parent = path.dirname(repo);
    const outer = path.join(parent, `outer-${path.basename(repo)}`);
    fs.mkdirSync(path.join(outer, 'inner', '.git'), { recursive: true });
    fs.writeFileSync(path.join(outer, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_stranger') } }));
    expect(resolveHookApiKey({ projectDir: path.join(outer, 'inner'), home, env: {} }).apiKey).toBeNull();
  });

  it('ignores somebody else\'s server and an implausible value', () => {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { other: { command: 'x', env: { DEERDAWN_API_KEY: 'dd_not_ours' } }, deerdawn: entry('two words') },
    }));
    expect(resolveHookApiKey({ projectDir: repo, home, env: {} }).apiKey).toBeNull();
  });

  it('a Codex flush ignores Claude Code registrations: shell, then saved key', () => {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_user_scope') } }));
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_repo') } }));
    expect(resolveHookApiKey({ claudeConfig: false, projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } }))
      .toEqual({ apiKey: 'dd_shell', source: 'env' });
  });
});

// Scan 13: a pinned key the API has revoked. The server recovers on its first
// 401 by adopting credentials.json; a hook does the same, and remembers.
describe('a pinned key the API rejected', () => {
  function withEverything() {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_user_scope') } }));
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_repo') } }));
    fs.mkdirSync(path.join(home, '.deerdawn'));
    fs.writeFileSync(path.join(home, '.deerdawn', 'credentials.json'), JSON.stringify({ api_key: 'dd_saved' }));
    return { home, repo };
  }
  const res = (status: number) => ({ ok: status >= 200 && status < 300, status });

  it('offers only the shell and credentials.json as fallbacks, never another registration', () => {
    const { home, repo } = withEverything();
    const choice = resolveHookApiKeys({ projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } });
    expect(choice.apiKey).toBe('dd_repo');
    expect(choice.fallbacks.map((f) => f.apiKey)).toEqual(['dd_shell', 'dd_saved']);
  });

  it('credentials.json itself has nothing to fall back to', () => {
    const { home, repo } = scratch();
    fs.mkdirSync(path.join(home, '.deerdawn'));
    fs.writeFileSync(path.join(home, '.deerdawn', 'credentials.json'), JSON.stringify({ api_key: 'dd_saved' }));
    expect(resolveHookApiKeys({ projectDir: repo, home, env: {} }).fallbacks).toEqual([]);
  });

  it('retries a 401 with each fallback once, keeps the accepted key, and records the dead one as a hash', async () => {
    const { home, repo } = withEverything();
    const sender = hookKeySender(resolveHookApiKeys({ projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } }));
    const tried: string[] = [];
    const out = await sender.send(async (key) => { tried.push(key); return res(key === 'dd_saved' ? 200 : 401); });
    expect(out.status).toBe(200);
    expect(tried).toEqual(['dd_repo', 'dd_shell', 'dd_saved']);
    expect(sender.key).toBe('dd_saved');
    const record = fs.readFileSync(path.join(home, '.deerdawn', 'rejected-pinned-keys.json'), 'utf8');
    expect(record).not.toContain('dd_repo');
    // The next hook skips the rejected key and starts at the next fallback.
    const next = resolveHookApiKeys({ projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } });
    expect(next.apiKey).toBe('dd_shell');
    expect(next.source).toBe('env');
  });

  it('never loops: every key refused is three requests and no record', async () => {
    const { home, repo } = withEverything();
    const sender = hookKeySender(resolveHookApiKeys({ projectDir: repo, home, env: { DEERDAWN_API_KEY: 'dd_shell' } }));
    let calls = 0;
    const out = await sender.send(async () => { calls += 1; return res(401); });
    expect(out.status).toBe(401);
    expect(calls).toBe(3);
    expect(fs.existsSync(path.join(home, '.deerdawn', 'rejected-pinned-keys.json'))).toBe(false);
  });

  it('does not move on for anything but a 401', async () => {
    const { home, repo } = withEverything();
    const sender = hookKeySender(resolveHookApiKeys({ projectDir: repo, home, env: {} }));
    let calls = 0;
    expect((await sender.send(async () => { calls += 1; return res(403); })).status).toBe(403);
    expect((await sender.send(async () => { calls += 1; return res(503); })).status).toBe(503);
    expect(calls).toBe(2);
  });

  it('a recorded rejection (the server swapped off it) is skipped for the saved key, never for another registration', () => {
    const { home, repo } = withEverything();
    recordRejectedPinnedKey('dd_repo', home);
    const choice = resolveHookApiKeys({ projectDir: repo, home, env: {} });
    expect(choice).toMatchObject({ apiKey: 'dd_saved', source: 'credentials', fallbacks: [] });
    expect(resolveHookApiKey({ projectDir: repo, home, env: {} })).toEqual({ apiKey: 'dd_saved', source: 'credentials' });
  });

  it('with nothing else on offer, a recorded key is still sent so the API reports the failure', () => {
    const { home, repo } = scratch();
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: entry('dd_repo') } }));
    recordRejectedPinnedKey('dd_repo', home);
    expect(resolveHookApiKey({ projectDir: repo, home, env: {} })).toEqual({ apiKey: 'dd_repo', source: 'project-config' });
  });
});
