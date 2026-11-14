/**
 * /setup is where the lifecycle emails land, and it handed CLI users a URL.
 *
 * The activation follow-up and the weekly digest both link /setup directly.
 * That was itself a fix (lifecycle-email-return-path, 2026-08-27): they used to
 * link /settings/tools, a redirect that stripped `?dd_email`, so
 * lifecycle_email_clicked read zero across 31 delivered emails. The link works
 * now — and what it opens, for a Claude Code or Codex user, was
 *
 *     https://api.deerdawn.com/mcp
 *
 * and nothing else. Claude Code registers MCP servers through its CLI; there is
 * no menu to paste that into. The one page a returning, already-stalled user is
 * sent to showed them a string they cannot act on, which spends the return path
 * that fix bought and gives back nothing.
 *
 * Every tool now gets the artifact its own surface takes, from connectCopy —
 * the shared source /connect and the onboarding step already render, so the
 * three pages cannot tell a user three different stories. Nothing here is new
 * copy.
 *
 * Run: `node tests/setup-page-actionable-command.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'src/pages/setup.tsx'), 'utf8');
const connectCopy = fs.readFileSync(path.join(root, 'src/lib/connectCopy.ts'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Setup Page Actionable Command Contracts ===\n');

test('the CLI tools are handed a command, not a URL', () => {
  assert.ok(
    page.includes('ONE_COMMAND_SETUP'),
    'Claude Code must be shown the one-command setup. It registers MCP servers ' +
      'through its CLI and cannot accept a pasted URL, so the remote endpoint is ' +
      'not an instruction for it — it is a string with nothing to do.',
  );
  assert.ok(
    page.includes('CODEX_CLI_SETUP_CMDS'),
    'Codex must be shown its own two commands. It has no connector menu either, ' +
      'and `npx … setup` does not configure it (runSetup only touches Claude Code), ' +
      'so it cannot be sent down the Claude Code path.',
  );
});

test('the config-file tools are handed the config', () => {
  assert.ok(
    page.includes('LOCAL_NPX_CONFIG_JSON'),
    'Cursor / Claude Desktop / ChatGPT Desktop take a config file, so that is ' +
      'what the page should give them',
  );
});

test('the hosted tools still get the URL', () => {
  // The browser tools are the case the bare URL was right for all along.
  assert.ok(page.includes('REMOTE_MCP_URL'), 'the remote endpoint must survive for the hosted tools');
});

test('every artifact comes from connectCopy, not from new copy on this page', () => {
  // The whole point of the shared module: three surfaces, one story. A command
  // retyped here is a command that can drift from /connect and from onboarding.
  for (const name of ['ONE_COMMAND_SETUP', 'CODEX_CLI_SETUP_CMDS', 'LOCAL_NPX_CONFIG_JSON', 'REMOTE_MCP_URL']) {
    assert.ok(
      connectCopy.includes(`export const ${name}`),
      `${name} should be exported by connectCopy`,
    );
  }
  const importBlock = page.slice(page.indexOf("from '@/lib/connectCopy'") - 400, page.indexOf("from '@/lib/connectCopy'"));
  for (const name of ['ONE_COMMAND_SETUP', 'CODEX_CLI_SETUP_CMDS', 'LOCAL_NPX_CONFIG_JSON', 'REMOTE_MCP_URL']) {
    assert.ok(
      importBlock.includes(name),
      `${name} must be imported from connectCopy, not re-declared in setup.tsx`,
    );
  }
  // No literal copy of any of them, which is how the two connectCopy files
  // drifted 3.5KB apart in the first place.
  assert.ok(
    !/npx -y @deerdawn\/mcp-server@latest setup/.test(page),
    'the setup command is inlined as a literal. Import ONE_COMMAND_SETUP instead ' +
      'so the three surfaces cannot drift.',
  );
  assert.ok(
    !/https:\/\/api\.deerdawn\.com/.test(page),
    'the API host is inlined as a literal. Use the connectCopy constant.',
  );
});

test('a shown artifact is copyable', () => {
  // Terminal commands and config blobs are retyped wrong. The page rendered its
  // code block with no way to copy it at all, which is a second reason a CLI
  // user could not act on what they were shown.
  const block = page.slice(page.indexOf('const SETUP_ARTIFACTS'), page.indexOf('const SETUP_ARTIFACTS') + 3000);
  assert.ok(block.length > 0, 'SETUP_ARTIFACTS not found');
  assert.ok(
    /navigator\.clipboard\.writeText\(\s*artifact/.test(page) || /copyArtifact/.test(page),
    'the artifact panel should offer a copy control',
  );
});

test('each tool says what to DO with what it is shown', () => {
  // A command and a config file and a URL are three different actions, and the
  // page used to present all of them as one unlabelled code block.
  assert.ok(
    /Run in your terminal/.test(page),
    'the terminal path should say it is a terminal command',
  );
  assert.ok(
    /via: 'terminal'/.test(page) && /via: 'file'/.test(page) && /via: 'browser'/.test(page),
    'the three surfaces should be distinguished explicitly, the way ' +
      'REMOTE_SETUP_LOCATIONS.setupVia already distinguishes them on /connect',
  );
});

test('every MCP tool card has an artifact', () => {
  // The failure mode this replaces was a default that happened to be wrong for
  // most tools. A tool with no entry must fall back to something, and the
  // fallback must be named rather than implied.
  const ids = [...page.matchAll(/^\s+id: '([a-z-]+)',$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 7, `expected the AI_TOOLS ids, found ${ids.length}`);
  const artifacts = page.slice(page.indexOf('const SETUP_ARTIFACTS'), page.indexOf('interface ApiKey'));
  for (const id of ids) {
    // The two userscript tools install by download and legitimately have none.
    if (id === 'gemini' || id === 'perplexity') continue;
    // A key that needs no quotes (`cursor:`) is written without them.
    assert.ok(
      new RegExp(`(^|\\s)'?${id}'?:\\s*\\{`, 'm').test(artifacts),
      `${id} has no setup artifact, so it falls through to whatever the default is`,
    );
  }
});

if (process.exitCode) {
  console.error('\nSetup page actionable command contracts failed.');
} else {
  console.log('\nSetup page actionable command contracts in place.');
}
