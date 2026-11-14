/**
 * The connector menu path, as the three pages that show it now receive it.
 *
 * Replaces tests/tools-remote-mcp-contract.test.js, which read setup.tsx as text
 * and asserted that it contained the sentence "Open Claude.ai settings, then
 * Integrations." That is the BUG, pinned: Claude.ai has no Integrations menu,
 * /connect and onboarding both said Connectors, and the suite that should have
 * caught the disagreement was the thing holding one third of it in place.
 *
 * These assert on the imported values instead: there is one path per tool, the
 * per-tool table row and the numbered steps are both built from it, and the
 * hosted Cursor entry is a URL with no credential beside it.
 *
 * Run: `tsx --test src/lib/connectCopy.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_MENU_PATHS,
  CONNECT_GUIDE_ANCHORS,
  CURSOR_REMOTE_CONFIG_JSON,
  DEERDAWN_API_URL,
  REMOTE_MCP_URL,
  REMOTE_SETUP_LOCATIONS,
  connectGuideAnchor,
  connectorMenuLine,
  connectorSetupSteps,
  type ConnectorTool,
} from './connectCopy';

const TOOLS = Object.keys(CONNECTOR_MENU_PATHS) as ConnectorTool[];

test('the canonical remote endpoint is unchanged', () => {
  assert.equal(DEERDAWN_API_URL, 'https://api.deerdawn.com');
  assert.equal(REMOTE_MCP_URL, 'https://api.deerdawn.com/mcp');
});

test('both browser tools have a menu path', () => {
  assert.deepEqual(TOOLS.sort(), ['ChatGPT.com', 'Claude.ai']);
});

test('the table row and the numbered steps name the same menu', () => {
  for (const tool of TOOLS) {
    const { menu, action } = CONNECTOR_MENU_PATHS[tool];
    const row = REMOTE_SETUP_LOCATIONS.find((r) => r.tool === tool);
    assert.ok(row, `REMOTE_SETUP_LOCATIONS lost its ${tool} row`);
    assert.ok(
      row.where.startsWith(connectorMenuLine(tool)),
      `${tool}: the table says "${row.where}" and the path is "${connectorMenuLine(tool)}"`,
    );

    const [first] = connectorSetupSteps(tool);
    assert.ok(first.includes(menu) && first.includes(action), `${tool}: step 1 does not name its own menu path`);
  }
});

test('no step sends a Claude.ai user to a menu it does not have', () => {
  const steps = connectorSetupSteps('Claude.ai').join(' ');
  assert.ok(!/integration/i.test(steps), 'Claude.ai calls these connectors; "Integrations" is the old name');
  assert.ok(/connector/i.test(steps));
});

test('the steps still cover the URL, the OAuth question and the approval', () => {
  for (const tool of TOOLS) {
    const steps = connectorSetupSteps(tool);
    assert.equal(steps.length, 3);
    assert.match(steps[1], /DeerDawn MCP URL/);
    assert.match(steps[1], /OAuth/, `${tool}: the form asks about OAuth and the steps must answer it`);
    assert.match(steps[2], /[Ss]ign in/);
    assert.ok(!steps.join(' ').includes('Bearer'), 'manual bearer-token setup is not the primary flow');
  }
});

test('the hosted Cursor entry is the URL and nothing else', () => {
  assert.deepEqual(JSON.parse(CURSOR_REMOTE_CONFIG_JSON), {
    mcpServers: { deerdawn: { url: REMOTE_MCP_URL } },
  });
});

test('a "Full guide" link is only built for a card /connect has a section for', () => {
  for (const id of CONNECT_GUIDE_ANCHORS) assert.equal(connectGuideAnchor(id), `#${id}`);
  assert.equal(connectGuideAnchor('some-future-card'), null);
  assert.equal(new Set(CONNECT_GUIDE_ANCHORS).size, CONNECT_GUIDE_ANCHORS.length, 'duplicate anchor');
});
