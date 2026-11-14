import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two readers of the user's CLAUDE.md went around the consent gate.
 *
 * first-run-import.ts settled the rule for the project import: nothing uploads
 * without the user saying so, and nothing is read except through
 * readUserAuthoredContext, which masks secrets. Two older paths never joined it:
 *
 *   THE CONNECT-TIME PROFILE SEED (index.ts). On every boot of an account with
 *   no profile, it readFileSync'd ~/.claude/CLAUDE.md, ./CLAUDE.md and
 *   ./AGENTS.md raw, lifted `About me:` / `Preferences:` / `Default stack:` out
 *   of them and called updateGlobalContext. No opt-in, no redaction — and
 *   ~/.claude/CLAUDE.md is the user's PRIVATE, cross-project instruction file.
 *
 *   complete_setup (tools/auth.ts). It ran the import preview and then confirmed
 *   that preview itself, in the same call. A preview nobody is shown is not a
 *   consent step; it is an upload with extra latency. This is the first tool a
 *   new install runs.
 */

const TOUCHED_ENV = ['HOME', 'DEERDAWN_HOME', 'DEERDAWN_AUTO_IMPORT', 'CLAUDE_PROJECT_DIR'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV) ORIGINAL_ENV[key] = process.env[key];

const PRIVATE_CLAUDE_MD = [
  '# How I work',
  '',
  'About me: Staff engineer at Acme, deploy token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 lives in 1Password',
  'Preferences: terse answers, no emojis, tabs',
  'Default stack: TypeScript, Postgres, Fly',
  '',
  'I review everything before it merges and I would rather be asked than surprised. Keep explanations',
  'short, prefer a failing test over a description of the bug, and never push without being told to.',
].join('\n');

describe('the connect-time global profile seed', () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-boot-seed-home-')));
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-boot-seed-ws-')));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), PRIVATE_CLAUDE_MD, 'utf8');
    process.env.HOME = home;
    process.env.DEERDAWN_HOME = path.join(home, '.deerdawn');
    delete process.env.DEERDAWN_AUTO_IMPORT;
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function load() {
    vi.resetModules();
    return import('../src/first-run-import.js');
  }

  it('builds nothing to upload for a user who never opted in', async () => {
    const { buildGlobalProfileSeed } = await load();
    expect(buildGlobalProfileSeed(workspace)).toBeNull();
  });

  it('seeds the profile for a user who opted in, with secrets masked', async () => {
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    const { buildGlobalProfileSeed } = await load();
    const patch = buildGlobalProfileSeed(workspace);

    expect(patch).not.toBeNull();
    expect(String(patch!.user_profile)).toContain('Staff engineer at Acme');
    expect(patch!.preferences).toEqual(['terse answers', 'no emojis', 'tabs']);
    expect(patch!.global_stack).toEqual(['TypeScript', 'Postgres', 'Fly']);
    // Marked as the unattended seed, so it never settles the profile review note.
    expect(patch!.source).toBe('seed');
    expect(JSON.stringify(patch)).not.toContain('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  });

  it('takes the opt-in from ~/.deerdawn/config.json too', async () => {
    fs.writeFileSync(path.join(home, '.deerdawn', 'config.json'), JSON.stringify({ auto_import_local: true }), 'utf8');
    const { buildGlobalProfileSeed } = await load();
    expect(buildGlobalProfileSeed(workspace)?.user_profile).toBeTruthy();
  });

  it('never reads a project file for the profile, even when there is no private one', async () => {
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    fs.rmSync(path.join(home, '.claude', 'CLAUDE.md'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), PRIVATE_CLAUDE_MD.replace('Staff engineer', 'Principal engineer'), 'utf8');
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), PRIVATE_CLAUDE_MD.replace('Staff engineer', 'Principal engineer'), 'utf8');
    const { buildGlobalProfileSeed } = await load();
    expect(buildGlobalProfileSeed(workspace)).toBeNull();
  });

  it('a project file never wins over, or adds to, the private one', async () => {
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'About me: Project note\nPreferences: loud\n\nA long enough paragraph of project text to count as authored content.', 'utf8');
    const { buildGlobalProfileSeed } = await load();
    const patch = buildGlobalProfileSeed(workspace);
    expect(String(patch!.user_profile)).toContain('Staff engineer at Acme');
    expect(JSON.stringify(patch)).not.toContain('Project note');
  });

  it('reads ~/.deerdawn-context.md when there is no ~/.claude/CLAUDE.md', async () => {
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    fs.rmSync(path.join(home, '.claude', 'CLAUDE.md'));
    fs.writeFileSync(path.join(home, '.deerdawn-context.md'), PRIVATE_CLAUDE_MD.replace('Staff engineer', 'Principal engineer'), 'utf8');
    const { buildGlobalProfileSeed } = await load();
    expect(String(buildGlobalProfileSeed(workspace)?.user_profile)).toContain('Principal engineer');
  });

  it('reads the second key when the first is absent', async () => {
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    fs.writeFileSync(
      path.join(home, '.claude', 'CLAUDE.md'),
      PRIVATE_CLAUDE_MD.replace('Preferences:', 'Always:').replace('Default stack:', 'Tech stack:'),
      'utf8',
    );
    const { buildGlobalProfileSeed } = await load();
    const patch = buildGlobalProfileSeed(workspace);
    expect(patch?.preferences).toEqual(['terse answers', 'no emojis', 'tabs']);
    expect(patch?.global_stack).toEqual(['TypeScript', 'Postgres', 'Fly']);
  });
});

describe('complete_setup and the local import', () => {
  beforeEach(() => {
    delete process.env.DEERDAWN_AUTO_IMPORT;
    process.env.DEERDAWN_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-setup-consent-')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../src/auth.js');
    vi.doUnmock('../src/config.js');
    vi.doUnmock('../src/client.js');
    vi.doUnmock('../../shared-context/src/setup-status.js');
    vi.doUnmock('../src/tools/context-sync.js');
    fs.rmSync(process.env.DEERDAWN_HOME!, { recursive: true, force: true });
    for (const key of TOUCHED_ENV) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  async function runCompleteSetup() {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const importCalls: Array<Record<string, unknown>> = [];
    const handleContextSyncTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      importCalls.push(args);
      return {
        content: [{
          type: 'text',
          text: args?.confirmed
            ? 'Imported "Demo Project" (project_123).'
            : 'Found /tmp/CLAUDE.md (500 chars).\nPreview:\n# Demo',
        }],
      };
    });
    vi.doMock('../src/auth.js', () => ({
      beginDeviceFlow: vi.fn(),
      clearPendingAuth: vi.fn(),
      isPendingAuthFresh: vi.fn().mockReturnValue(false),
      loadPendingAuth: vi.fn().mockReturnValue(null),
      loadSavedApiKey: vi.fn().mockReturnValue('dd_test_key'),
    }));
    vi.doMock('../src/config.js', () => ({
      loadConfig: vi.fn().mockReturnValue({
        apiUrl: 'https://api.deerdawn.com', apiKey: null, environment: 'production',
        cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 1, retryBackoffMs: 100,
      }),
    }));
    vi.doMock('../src/client.js', () => ({
      DeerdawnClient: vi.fn().mockImplementation(function () { return { mocked: true }; }),
    }));
    vi.doMock('../../shared-context/src/setup-status.js', () => ({
      applySurfaceSetup: vi.fn().mockReturnValue({ applied: true, surface: 'cursor' }),
      inspectLocalSetupStatus: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('../src/tools/context-sync.js', async () => {
      const actual = await vi.importActual<any>('../src/tools/context-sync.js');
      return { ...actual, handleContextSyncTool };
    });

    const { handleAuthTool } = await import('../src/tools/auth.js');
    const result = await handleAuthTool('complete_setup', { surface: 'cursor' }) as any;
    return { payload: JSON.parse(result.content[0].text), importCalls };
  }

  it('stops after the preview: nothing is confirmed on the user’s behalf', async () => {
    const { payload, importCalls } = await runCompleteSetup();

    expect(importCalls.filter((args) => args.confirmed), 'a preview must not confirm itself').toHaveLength(0);
    expect(importCalls).toHaveLength(1);
    expect(payload.completed).toBe(true);
    expect(payload.import.imported).toBe(false);
    expect(payload.import.message).toContain('Found /tmp/CLAUDE.md');
    // The way to say yes has to be a tool the client can actually see.
    expect(payload.nextAction).toContain('manage_memory(action:"import_local", confirmed:true)');
  });

  it('still imports in one call for a user with the standing opt-in', async () => {
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    const { payload, importCalls } = await runCompleteSetup();

    expect(importCalls).toHaveLength(2);
    expect(importCalls[1].confirmed).toBe(true);
    expect(payload.import.imported).toBe(true);
    expect(payload.import.message).toContain('Imported');
  });
});
