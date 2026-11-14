import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySurfaceSetup, inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { findPlainTextKeys, removePlainTextKeys, removeStaleBlock } from '../src/managed-block.js';

/**
 * remove-key REMOVES THE KEY, AND SAYS SO ONLY WHEN IT DID.
 *
 * Reviewed defects: the backup remove-key takes of the file was written 0644 in a
 * 0755 directory with the key inside, and never pruned, so the key stayed on disk
 * beside a message saying it was gone; a settings.json with comments or trailing
 * commas (Claude Code's settings.json accepts both) did not parse, so remove-key
 * answered "Nothing changed" while the key was in the file; the rewrite was not
 * atomic and re-serialised the whole file; remove-block did not say another
 * DeerDawn block was still there.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const KEY = 'dd_live_PLAINTEXT_KEY_1234567890';
let home: string;

const write = (rel: string, text: string, mode?: number) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode === undefined ? undefined : { mode });
  return file;
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const backupsDir = () => path.join(home, '.deerdawn', 'setup-backups');
const backupFiles = () => (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()).sort() : []);

const JSONC = `// Claude Code settings, kept by hand
{
  /* which model */
  "model": "opus",
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com", // the API
        "DEERDAWN_API_KEY": "${KEY}",
      },
    },
  },
}
`;

beforeEach(() => {
  home = process.env.HOME as string;
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backups that can hold a key are private', () => {
  it('a backup is 0600 in a 0700 directory, even when the directory already exists at 0755', () => {
    write('.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
    fs.mkdirSync(backupsDir(), { recursive: true, mode: 0o755 });
    fs.chmodSync(backupsDir(), 0o755);
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));

    applySurfaceSetup('cursor', 'repair');

    expect(mode(backupsDir())).toBe(0o700);
    expect(backupFiles().length).toBeGreaterThan(0);
    for (const name of backupFiles()) expect(mode(path.join(backupsDir(), name))).toBe(0o600);
  });

  it('only the newest five backups of a tool are kept', () => {
    write('.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
    fs.mkdirSync(backupsDir(), { recursive: true });
    for (let n = 0; n < 8; n += 1) fs.writeFileSync(path.join(backupsDir(), `cursor-2026-01-0${n + 1}T00-00-00-000Z.json`), `{"old":${n}}`);
    write('.cursor/mcp.json', '{}');

    applySurfaceSetup('cursor', 'repair');

    const cursor = backupFiles().filter((name) => name.startsWith('cursor-'));
    expect(cursor).toHaveLength(5);
    expect(cursor).not.toContain('cursor-2026-01-01T00-00-00-000Z.json');
  });
});

describe('remove-key takes the key off the disk', () => {
  it('its own backup holds the file with the key redacted, 0600, and an older backup that holds the key is redacted too', () => {
    write('.claude/settings.json', JSONC);
    const older = path.join(backupsDir(), 'claude_code-2026-01-01T00-00-00-000Z.json');
    fs.mkdirSync(backupsDir(), { recursive: true });
    fs.writeFileSync(older, JSONC, { mode: 0o644 });

    const [outcome] = removePlainTextKeys() as any[];

    expect(outcome.removed).toBe(true);
    for (const name of backupFiles()) {
      const file = path.join(backupsDir(), name);
      expect(fs.readFileSync(file, 'utf8'), name).not.toContain(KEY);
      expect(mode(file), name).toBe(0o600);
    }
    expect(fs.readFileSync(outcome.backup_path, 'utf8')).toContain('"model": "opus"');
    expect(outcome.redacted_backups).toBe(1);
    expect(read('.claude/settings.json')).not.toContain(KEY);
  });

  it('a settings.json with comments and trailing commas is read: the key is found, removed, and everything else stays byte for byte', () => {
    write('.claude/settings.json', JSONC, 0o600);

    const status = inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any;
    expect(status.diagnostics.plain_text_keys).toHaveLength(1);
    expect(status.diagnostics.plain_text_keys[0].summary).toContain('~/.claude/settings.json');

    const [outcome] = removePlainTextKeys() as any[];

    expect(outcome.removed).toBe(true);
    expect(read('.claude/settings.json')).toBe(JSONC.replace(`        "DEERDAWN_API_KEY": "${KEY}",\n`, ''));
    expect(mode(path.join(home, '.claude', 'settings.json'))).toBe(0o600);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['settings.json']);
  });

  it('when the key is the last member, the comma before it goes with it', () => {
    const text = `{\n  "mcpServers": {\n    "deerdawn": {\n      "command": "npx",\n      "env": { "A": "1", "DEERDAWN_API_KEY": "${KEY}" }\n    }\n  }\n}\n`;
    write('.claude/settings.json', text);

    removePlainTextKeys();

    expect(read('.claude/settings.json')).toBe(text.replace(`, "DEERDAWN_API_KEY": "${KEY}"`, ''));
  });

  it('the last key of env: a comment on the previous member\'s line is kept, and only the comma goes', () => {
    const text = `{\n  "mcpServers": {\n    "deerdawn": {\n      "command": "npx",\n      "env": {\n        "OTHER": "1", // keep me\n        "DEERDAWN_API_KEY": "${KEY}"\n      }\n    }\n  }\n}\n`;
    write('.claude/settings.json', text);

    removePlainTextKeys();

    expect(read('.claude/settings.json')).toBe(text.replace(`"OTHER": "1", // keep me\n        "DEERDAWN_API_KEY": "${KEY}"\n`, `"OTHER": "1" // keep me\n`));
  });

  it('a block comment between the previous member and the key is kept too, inline', () => {
    const text = `{ "mcpServers": { "deerdawn": { "command": "npx", "env": { "OTHER": "1", /* keep me */ "DEERDAWN_API_KEY": "${KEY}" } } } }\n`;
    write('.claude/settings.json', text);

    removePlainTextKeys();

    const after = read('.claude/settings.json');
    expect(after).toContain('/* keep me */');
    expect(after).not.toContain(KEY);
    expect(after).toContain('"OTHER": "1"');
    expect(after).not.toMatch(/"OTHER": "1",/);
    expect(findPlainTextKeys(home)).toEqual([]);
  });

  it('a comment on the key\'s own line goes with the key', () => {
    const text = `{\n  "mcpServers": {\n    "deerdawn": {\n      "env": {\n        "OTHER": "1",\n        "DEERDAWN_API_KEY": "${KEY}" // pinned\n      }\n    }\n  }\n}\n`;
    write('.claude/settings.json', text);

    removePlainTextKeys();

    expect(read('.claude/settings.json')).toBe(text.replace(`,\n        "DEERDAWN_API_KEY": "${KEY}" // pinned`, ''));
  });

  it('a file that cannot be parsed is named and said so, never "nothing changed"', () => {
    const broken = `{ "mcpServers": { "deerdawn": { "env": { "DEERDAWN_API_KEY": "${KEY}" } } \n`;
    write('.claude/settings.json', broken);

    const found = findPlainTextKeys(home) as any[];
    const outcomes = removePlainTextKeys() as any[];

    expect(found).toHaveLength(1);
    expect(found[0].readable).toBe(false);
    expect(found[0].summary).toContain('~/.claude/settings.json');
    expect(found[0].summary).toContain('cannot be read');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].removed).toBe(false);
    expect(outcomes[0].path).toBe(path.join(home, '.claude', 'settings.json'));
    expect(outcomes[0].reason).toMatch(/cannot be parsed/);
    expect(read('.claude/settings.json')).toBe(broken);
  });

  it('a file that cannot be parsed and holds no DeerDawn key says nothing', () => {
    write('.claude/settings.json', '{ not json');
    expect(findPlainTextKeys(home)).toEqual([]);
  });

  it('a symlinked settings.json is refused, and its target keeps the key untouched', () => {
    const target = write('dotfiles/settings.json', JSONC);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(target, path.join(home, '.claude', 'settings.json'));

    const [outcome] = removePlainTextKeys() as any[];

    expect(outcome.removed).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(JSONC);
  });
});

describe('remove-block says when another DeerDawn block remains', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const OTHER = 'e'.repeat(32);
  const block = (token: string) => buildOnDiskInstructionBlock([], token).trimEnd();

  beforeEach(() => {
    write('.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
    write('.codex/config.toml', 'model = "o3"\n');
  });

  it('a second block of this install: removed one, the other is named', () => {
    write('.codex/AGENTS.md', `# Notes\n\n${block(TOKEN)}\n\nbetween\n\n${block(TOKEN)}\n`);

    const outcome = removeStaleBlock('codex', { runningSurface: null }) as any;

    expect(outcome.removed).toBe(true);
    expect(outcome.remaining).toBe('owned');
    expect(read('.codex/AGENTS.md')).toContain(TOKEN);
  });

  it('a block from another install beside it: removed ours, the other is named', () => {
    write('.codex/AGENTS.md', `# Notes\n\n${block(TOKEN)}\n\n${block(OTHER)}\n`);

    const outcome = removeStaleBlock('codex', { runningSurface: null }) as any;

    expect(outcome.removed).toBe(true);
    expect(outcome.remaining).toBe('other_install');
    expect(read('.codex/AGENTS.md')).toContain(OTHER);
  });

  it('nothing left: no remaining block is claimed', () => {
    write('.codex/AGENTS.md', `# Notes\n\n${block(TOKEN)}\n`);
    expect((removeStaleBlock('codex', { runningSurface: null }) as any).remaining ?? null).toBeNull();
  });
});
