// `setup` against a self-hosted DeerDawn: the API it signs in to is the API it
// registers, and the one the hooks call. Hosted output stays exactly as it was.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_API_URL,
  buildClaudeMcpAddArgs,
  formatClaudeMcpAddCommand,
  recordHookApiUrl,
  resolveSetupApiUrl,
} from '../src/setup-plan.js';

describe('resolveSetupApiUrl', () => {
  it('defaults to the hosted API', () => {
    expect(resolveSetupApiUrl([], {})).toEqual({ apiUrl: DEFAULT_API_URL, source: 'default', error: null });
    expect(DEFAULT_API_URL).toBe('https://api.deerdawn.com');
  });

  it('honours DEERDAWN_API_URL', () => {
    expect(resolveSetupApiUrl([], { DEERDAWN_API_URL: 'https://dd.example.com/' }))
      .toEqual({ apiUrl: 'https://dd.example.com', source: 'env', error: null });
  });

  it('prefers --api-url over the env, in both spellings', () => {
    const env = { DEERDAWN_API_URL: 'https://env.example.com' };
    expect(resolveSetupApiUrl(['--api-url', 'http://localhost:3000'], env).apiUrl).toBe('http://localhost:3000');
    expect(resolveSetupApiUrl(['--api-url=https://flag.example.com'], env))
      .toEqual({ apiUrl: 'https://flag.example.com', source: 'flag', error: null });
  });

  it('refuses a missing or non-http value instead of silently using hosted', () => {
    expect(resolveSetupApiUrl(['--api-url'], {}).error).toMatch(/needs a value/);
    expect(resolveSetupApiUrl(['--api-url', '--other'], {}).error).toMatch(/needs a value/);
    expect(resolveSetupApiUrl(['--api-url', 'dd.example.com'], {}).error).toMatch(/not a URL/);
    expect(resolveSetupApiUrl([], { DEERDAWN_API_URL: 'ftp://dd.example.com' }).error).toMatch(/http\(s\)/);
  });
});

describe('the registration', () => {
  it('is byte-identical to before for hosted', () => {
    expect(buildClaudeMcpAddArgs()).toEqual([
      'mcp', 'add', '-s', 'user', 'deerdawn',
      '-e', 'DEERDAWN_API_URL=https://api.deerdawn.com',
      '-e', 'DEERDAWN_SURFACE_ID=claude_code',
      '--',
      'npx', '-y', '@deerdawn/mcp-server@latest',
    ]);
    expect(formatClaudeMcpAddCommand())
      .toBe('claude mcp add -s user deerdawn -e DEERDAWN_API_URL=https://api.deerdawn.com -- npx -y @deerdawn/mcp-server@latest');
  });

  it('carries a self-hosted URL', () => {
    expect(buildClaudeMcpAddArgs('https://dd.example.com')).toContain('DEERDAWN_API_URL=https://dd.example.com');
    expect(formatClaudeMcpAddCommand('http://localhost:3000')).toContain('DEERDAWN_API_URL=http://localhost:3000 ');
  });
});

describe('recordHookApiUrl', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-apiurl-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

  it('writes nothing for hosted on a fresh machine', () => {
    expect(recordHookApiUrl(DEFAULT_API_URL, dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  it('records a self-hosted URL and keeps the other keys', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auto_import_local: true }));
    expect(recordHookApiUrl('https://dd.example.com', dir)).toMatch(/Hooks will call https:\/\/dd\.example\.com/);
    expect(read()).toEqual({ auto_import_local: true, api_url: 'https://dd.example.com' });
    expect(recordHookApiUrl('https://dd.example.com', dir)).toBeNull(); // idempotent
  });

  it('removes it again when setup is re-run against hosted', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ api_url: 'https://dd.example.com', x: 1 }));
    expect(recordHookApiUrl(DEFAULT_API_URL, dir)).toMatch(/removed api_url/);
    expect(read()).toEqual({ x: 1 });
  });
});
