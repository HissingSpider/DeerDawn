'use strict';

// EVERY TEST RUNS IN A HOME OF ITS OWN, WHATEVER THE DEVELOPER'S SHELL HAS SET.
//
// The code under test honours these variables to decide which files are the
// person's: HOME (and USERPROFILE), CODEX_HOME (Codex's config.toml and
// AGENTS.md), DEERDAWN_HOME / DEERDAWN_HOME_DIR / DEERDAWN_DIR (credentials,
// peers, snapshots), CLAUDE_PROJECT_DIR (the repository project sync writes
// into) and CLAUDE_TRANSCRIPT_PATH (a transcript to read). Most tests set some
// of them and not the rest, so with any of them exported in the shell a test
// read or wrote the developer's real files: measured 2026-09-28, both suites
// under pre-seeded sentinels made about 1,000 accesses to them, rewrote the
// sentinel CODEX_HOME/AGENTS.md and ~/.claude/CLAUDE.md, and wrote a
// credentials.json into DEERDAWN_DIR.
//
// containTestProcess clears the path variables and points HOME at a fresh temp
// directory before a test file runs; a test that needs one sets its own, inside
// a directory it created. It also guards the developer's CODEX_HOME: the two
// files DeerDawn ever writes there (config.toml, AGENTS.md) are fingerprinted
// before the file's tests and checked after them, and a change fails the file.
//
// Wired in by packages/mcp-server/tests/setup/contain-home.ts (vitest
// setupFiles) and by a require at the top of each node:test file that touches
// the filesystem.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PATH_VARIABLES = ['CODEX_HOME', 'DEERDAWN_HOME', 'DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_TRANSCRIPT_PATH'];

// Remembered in the environment rather than in this module, because a vitest
// worker can run several test files and each one starts after the previous one
// cleared CODEX_HOME. Nothing in the product reads it.
const DEVELOPER_CODEX_HOME = 'DD_TEST_DEVELOPER_CODEX_HOME';

function developerCodexHome() {
  if (!(DEVELOPER_CODEX_HOME in process.env)) process.env[DEVELOPER_CODEX_HOME] = process.env.CODEX_HOME || '';
  return process.env[DEVELOPER_CODEX_HOME] ? path.resolve(process.env[DEVELOPER_CODEX_HOME]) : null;
}

function fingerprint(files) {
  return files.map((file) => {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch {
      return 'absent';
    }
  }).join(',');
}

/**
 * Contain this test process. `after` registers a hook that runs once this test
 * file's tests are done (vitest's afterAll, node:test's after); a throw from it
 * fails the file.
 */
function containTestProcess(after) {
  const codexHome = developerCodexHome();
  const guarded = codexHome ? ['config.toml', 'AGENTS.md'].map((name) => path.join(codexHome, name)) : [];
  const before = fingerprint(guarded);

  for (const key of PATH_VARIABLES) delete process.env[key];
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (guarded.length && fingerprint(guarded) !== before) {
      throw new Error(`A test wrote under CODEX_HOME=${codexHome}, a directory it did not create: ${guarded.join(' or ')} changed. Tests must leave CODEX_HOME unset or point it inside a temp directory of their own.`);
    }
  });
  return home;
}

module.exports = { PATH_VARIABLES, DEVELOPER_CODEX_HOME, containTestProcess };
