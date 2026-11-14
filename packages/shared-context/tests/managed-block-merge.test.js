const test = require('node:test');
// No home-like variable from the developer's shell reaches this file: see
// contain-home.cjs.
require('./contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDeerdawnInstructionBlock, openMarkerFor, closeMarkerFor } = require('../src/deerdawnInstructions.js');
const { applySurfaceSetup } = require('../src/setup-status.js');
const { buildLayouts } = require('./managed-block-layouts.cjs');

/**
 * apply_setup FINDS DEERDAWN'S BLOCK THE WAY A BOOT DOES.
 *
 * mergeInstructionText (what apply_setup writes into CLAUDE.md, AGENTS.md and
 * the Cursor rule with) found the block with indexOf(OPEN_MARKER) and
 * indexOf(CLOSE_MARKER), the second searched from the start of the file, so a
 * marker quoted in the person's prose, or a stray one an editor left behind,
 * decided what got replaced. With no markers it also TRIMMED the person's text
 * and put the block above it. The layouts are the boot tests' (see
 * managed-block-layouts.cjs): only a well-formed pair is replaced, otherwise the
 * block is appended, and running it again changes nothing.
 *
 * Everything runs under a throwaway home; nothing real is read or written.
 */

const ENV_KEYS = ['DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_SURFACE_ID', 'CODEX_HOME'];

function withHome(fn) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-merge-home-')));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-merge-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  delete process.env.DEERDAWN_API_KEY;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  delete process.env.DEERDAWN_SURFACE_ID;
  delete process.env.CODEX_HOME;
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  try {
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// This install's block token, written to install.json for every case, so the
// layouts (built when the file loads) can name it.
const TOKEN = '0123456789abcdef0123456789abcdef';
const NEW = buildDeerdawnInstructionBlock(TOKEN).trimEnd();

const SURFACES = [
  // Claude Code has a DeerDawn server registered where it reads servers.
  { surface: 'claude_code', rel: '.claude/CLAUDE.md', prepare: (home) => write(home, '.claude.json', JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } })) },
  // Registered already, so repair touches only AGENTS.md.
  { surface: 'codex', rel: '.codex/AGENTS.md', prepare: (home) => write(home, '.codex/config.toml', '[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n') },
];

const TOKEN_LAYOUTS = { open: openMarkerFor(TOKEN), close: closeMarkerFor(TOKEN) };

// Seeded with the markers from before the token (migrated once), and with the
// token's own markers (refreshed in place).
for (const { surface, rel, prepare } of SURFACES) {
  for (const [source, layouts] of [['before the token', buildLayouts(NEW, { strict: true })], ['with the token', buildLayouts(NEW, { ...TOKEN_LAYOUTS, strict: true })]]) for (const layout of layouts) {
    test(`apply_setup(${surface}) into ${rel}, block ${source}: ${layout.name}`, () => {
      withHome((home) => {
        write(home, '.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
        prepare(home);
        write(home, rel, layout.seeded);

        const after = [];
        for (let run = 0; run < 3; run += 1) {
          applySurfaceSetup(surface, 'repair');
          after.push(fs.readFileSync(path.join(home, rel), 'utf8'));
        }

        assert.strictEqual(after[0], layout.expected);
        assert.strictEqual(after[1], after[0], 'a second run changes nothing');
        assert.strictEqual(after[2], after[0], 'a third run changes nothing');
      });
    });
  }
}

test('a file that already carries DeerDawn instructions without markers is left alone, as before', () => {
  withHome((home) => {
    const mine = '# Notes\n\nDeerDawn: call start_session first.\n';
    write(home, '.claude/CLAUDE.md', mine);

    applySurfaceSetup('claude_code', 'repair');

    assert.strictEqual(fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8'), mine);
  });
});
