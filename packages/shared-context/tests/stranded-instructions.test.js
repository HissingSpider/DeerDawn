const test = require('node:test');
// No home-like variable from the developer's shell reaches this file: see
// contain-home.cjs.
require('./contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCursorInstructionBlock } = require('../src/deerdawnInstructions.js');
const { inspectLocalSetupStatus } = require('../src/setup-status.js');

/**
 * get_setup_status says a tool's instruction file carries DeerDawn's
 * instructions with no server behind them (instructions_without_mcp_server).
 * It decided "carries DeerDawn's instructions" with includes(OPEN_MARKER), so a
 * person's own notes that QUOTE the marker, or a fenced example of it, read as
 * stranded instructions. It now finds a block the way every writer does.
 */

function withHome(fn) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stranded-')));
  const saved = { DEERDAWN_HOME_DIR: process.env.DEERDAWN_HOME_DIR, DEERDAWN_DIR: process.env.DEERDAWN_DIR };
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  try {
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const OPEN = '<!-- deerdawn:auto-context -->';
const CLOSE = '<!-- /deerdawn:auto-context -->';
const surfaceOf = (id) => inspectLocalSetupStatus().surfaces.find((s) => s.id === id);

for (const [label, text, stranded] of [
  ['the marker quoted in prose', `# Notes\nDeerDawn keeps its block between \`${OPEN}\` and \`${CLOSE}\`.\n`, false],
  ['a fenced example of the block', `# Notes\n\`\`\`md\n${OPEN}\n## DeerDawn\n${CLOSE}\n\`\`\`\n`, false],
  ['a lone opening marker', `# Notes\n${OPEN}\nleft by an editor\n`, false],
  ['a well-formed block', `# Notes\n\n${buildCursorInstructionBlock()}`, true],
]) {
  test(`a Codex AGENTS.md with ${label}, and no server: stranded is ${stranded}`, () => {
    withHome((home) => {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), text);
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n');

      assert.equal(surfaceOf('codex').degraded_reason, stranded ? 'instructions_without_mcp_server' : null);
    });
  });
}
