import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { MARKER_NAME_PREFIX } from '../src/instruction-block.js';

/**
 * A CODEX REGISTRATION IN ANY FORM TOML ALLOWS IS A REGISTRATION.
 *
 * Observed in a walk (2026-09-28): DeerDawn registered in ~/.codex/config.toml
 * as `[mcp_servers]` + `deerdawn = { url = "..." }`, or as
 * `mcp_servers.deerdawn.url = "..."`, which codex 0.154 lists as enabled. The
 * boot did not see it, so AGENTS.md got no block (round 1 removed the one it
 * had), get_setup_status said Codex was only "detected", and
 * complete_setup(codex) appended a second `[mcp_servers.deerdawn]` table and
 * answered completed:true. Codex then refuses the whole file as a duplicate key
 * and every MCP server the person had in Codex is dead.
 *
 * Everything runs under a throwaway HOME, with the API on a closed local port.
 */

let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_AUTO_IMPORT', 'DEERDAWN_SURFACE_ID', 'CODEX_HOME'];
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

function write(rel: string, content: string): string {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
// The install's block token, made by the first boot that writes a block.
const token = () => JSON.parse(read('.deerdawn/install.json')).block_token as string;

async function codexStatus(): Promise<any> {
  const { inspectLocalSetupStatus } = await import('../../shared-context/src/setup-status.js');
  return (inspectLocalSetupStatus() as any).surfaces.find((s: any) => s.id === 'codex');
}

const URL = 'https://api.deerdawn.com/mcp';
const USER_AGENTS = '# Codex rules\nBe terse. USERMARK-CODEX\n';
const FORMS: Array<[string, string]> = [
  ['inline table under [mcp_servers]', `model = "o3"\n[mcp_servers]\ndeerdawn = { url = "${URL}" }\n`],
  ['dotted keys under [mcp_servers]', `model = "o3"\n[mcp_servers]\ndeerdawn.url = "${URL}"\n`],
  ['top-level dotted keys', `model = "o3"\nmcp_servers.deerdawn.url = "${URL}"\n`],
  ['top-level inline table', `model = "o3"\nmcp_servers = { deerdawn = { url = "${URL}" } }\n`],
];

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-codex-forms-home-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-codex-forms-repo-')));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  delete process.env.DEERDAWN_API_KEY;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  delete process.env.DEERDAWN_AUTO_IMPORT;
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  process.env.DEERDAWN_SURFACE_ID = 'claude_code';
  delete process.env.CODEX_HOME;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a boot sees the registration, and the status agrees', () => {
  for (const [label, toml] of FORMS) {
    it(`${label}: AGENTS.md gets the block fitted to the hosted server, and Codex reads as configured`, async () => {
      write('.codex/AGENTS.md', USER_AGENTS);
      write('.codex/config.toml', toml);

      autoConfigureHooks({ tool: 'codex' });

      expect(read('.codex/AGENTS.md')).toBe(`${USER_AGENTS}\n${buildOnDiskInstructionBlock(['hosted'], token()).trimEnd()}\n`);
      expect(read('.codex/config.toml')).toBe(toml);
      expect((await codexStatus()).configured).toBe(true);
    });
  }
});

describe('complete_setup(codex) with DeerDawn already registered inline', () => {
  async function completeSetup(): Promise<any> {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.doMock('../src/tools/context-sync.js', async () => {
      const actual = await vi.importActual<any>('../src/tools/context-sync.js');
      return {
        ...actual,
        handleContextSyncTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'No local context files found.' }] }),
      };
    });
    try {
      const { handleAuthTool } = await import('../src/tools/auth.js');
      const result = await handleAuthTool('complete_setup', { surface: 'codex' }) as any;
      return JSON.parse(result.content[0].text);
    } finally {
      vi.doUnmock('../src/tools/context-sync.js');
      vi.unstubAllGlobals();
    }
  }

  for (const [label, toml] of FORMS) {
    it(`${label}: completed, and config.toml byte for byte (no second table)`, async () => {
      write('.codex/AGENTS.md', USER_AGENTS);
      write('.codex/config.toml', toml);

      const payload = await completeSetup();

      expect(read('.codex/config.toml')).toBe(toml);
      expect(payload.setup.already_configured).toBe(true);
      expect(payload.completed).toBe(true);
    });
  }
});

describe('CODEX_HOME is where Codex keeps both files', () => {
  // Verified against codex-cli 0.154: with CODEX_HOME set, `codex mcp list`
  // reads $CODEX_HOME/config.toml, and the instructions a model request carries
  // come from $CODEX_HOME/AGENTS.md, not ~/.codex/AGENTS.md.
  it('the block goes into $CODEX_HOME/AGENTS.md, on the registration in $CODEX_HOME/config.toml', async () => {
    const codexHome = path.join(home, 'dotfiles', 'codex');
    process.env.CODEX_HOME = codexHome;
    write('dotfiles/codex/config.toml', FORMS[0][1]);
    write('dotfiles/codex/AGENTS.md', USER_AGENTS);
    write('.codex/AGENTS.md', USER_AGENTS);

    autoConfigureHooks({ tool: 'codex' });

    expect(read('dotfiles/codex/AGENTS.md')).toContain(MARKER_NAME_PREFIX);
    expect(read('.codex/AGENTS.md')).toBe(USER_AGENTS);
    expect((await codexStatus()).configured).toBe(true);
  });

  it('a registration left in ~/.codex does not count while CODEX_HOME points elsewhere', async () => {
    process.env.CODEX_HOME = path.join(home, 'dotfiles', 'codex');
    write('dotfiles/codex/config.toml', 'model = "o3"\n');
    write('dotfiles/codex/AGENTS.md', USER_AGENTS);
    write('.codex/config.toml', FORMS[0][1]);
    write('.codex/AGENTS.md', USER_AGENTS);

    autoConfigureHooks({ tool: 'codex' });

    expect(read('dotfiles/codex/AGENTS.md')).toBe(USER_AGENTS);
    expect(read('.codex/AGENTS.md')).toBe(USER_AGENTS);
    expect((await codexStatus()).configured).toBe(false);
  });
});
