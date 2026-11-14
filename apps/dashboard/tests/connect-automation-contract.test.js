/**
 * The connect step must hand over the standing instruction (2026-08-26).
 *
 * Measured over the 90 days to 2026-08-26: 8 real accounts ever completed an MCP
 * handshake, and 3 of them never produced a single tool call. Their connectors
 * kept re-handshaking afterwards — one user's Claude.ai loaded DeerDawn again on
 * day 7 and still called nothing. `connection_established` requires a
 * start_session that reaches the server, so those accounts could not activate by
 * construction, no matter what the funnel copy above them said.
 *
 * The cause is not a bug. A connector is not a trigger: nothing invokes
 * start_session unless the user asks, or unless a standing instruction in the
 * tool tells the model to. That instruction existed (CLAUDE_AI_SYSTEM_PROMPT)
 * but lived only on step 2 of onboarding, as a secondary button, below the
 * primary path — after the point where the silent users had already left.
 *
 * What is pinned here is the thing that would silently regress: the block being
 * dropped, being gated on a connection state the silent users never reach, or
 * the prompt being rephrased until it no longer names the tool it must call.
 * (#250 removed an entire mobile offer by rewording three words; the same class
 * of regression is what this guards.)
 *
 * Run: `node tests/connect-automation-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const onboarding = fs.readFileSync(path.join(root, 'src/pages/onboarding.tsx'), 'utf8');
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

test('the connect step renders the automation card', () => {
  assert.ok(
    /<AutomationPromptCard\s+tool=\{selectedTool\}\s*\/>/.test(onboarding),
    'AutomationPromptCard must be rendered on the connect step with the selected tool'
  );
});

test('the automation card is not gated on a connection being detected', () => {
  // The two accounts that connected and went silent in August left this page in
  // 3 and 13 seconds. A block that waits for `status` to leave 'waiting' would
  // have rendered for neither of them, which is the entire failure being fixed.
  const render = onboarding.slice(onboarding.indexOf('<AutomationPromptCard') - 400, onboarding.indexOf('<AutomationPromptCard'));
  assert.ok(
    !/status\s*[=!]==?\s*'(waiting|detected|synced)'\s*&&\s*$/.test(render.trim()),
    'the automation card must not be gated on connection status'
  );
});

test('every setup path has a named place to put the instruction', () => {
  const tools = [...connectCopy.matchAll(/\{\s*tool:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(tools.length >= 7, `expected the full tool picker, found ${tools.length}`);
  for (const tool of tools) {
    assert.ok(
      connectCopy.includes(`'${tool}': { where:`),
      `AUTOMATION_SETUP is missing an entry for ${tool} — it would fall back to generic advice`
    );
  }
});

test('both standing instructions still name start_session', () => {
  for (const name of ['CLAUDE_AI_SYSTEM_PROMPT', 'CHATGPT_SYSTEM_PROMPT']) {
    const start = connectCopy.indexOf(`export const ${name}`);
    assert.ok(start !== -1, `${name} must exist`);
    const body = connectCopy.slice(start, connectCopy.indexOf('`;', start));
    assert.ok(
      body.includes('start_session'),
      `${name} must tell the tool to call start_session — without it the prompt does nothing`
    );
    // Must close the loop with a WRITE — but with one the servers actually
    // advertise. This asserted `update_context` until 2026-08-29, which pinned
    // the bug in place: update_context sits in GROUPED_LEGACY (dispatchable,
    // never in tools/list), so this prompt — which the user pastes into their
    // permanent custom instructions and never revisits — told the model to call
    // a tool it cannot see.
    assert.ok(
      body.includes('manage_memory'),
      `${name} must close the loop with manage_memory, the advertised write tool`
    );
    assert.ok(
      !body.includes('update_context'),
      `${name} names update_context, which is not in tools/list — the model will report it does not exist`
    );
  }
});

test('the detected banner no longer claims the user is done', () => {
  // It used to read "Connected. You're ready — next you'll capture your first
  // brief." That is a congratulation for a state in which the tool has, by
  // definition, never called us.
  assert.ok(
    !/You&apos;re ready — next you&apos;ll capture your first brief/.test(onboarding),
    'the detected state must not congratulate a connection that has done nothing yet'
  );
  assert.ok(
    /Connected — but nothing has been asked of it yet/.test(onboarding),
    'the detected state must name what has actually happened'
  );
});

test('the impression event is an observer, not a mount', () => {
  assert.ok(
    /threshold:\s*0\.5/.test(onboarding),
    'connect_automation_shown must be an IntersectionObserver impression'
  );
  assert.ok(
    /connect_automation_shown/.test(onboarding) && /connect_automation_copied/.test(onboarding),
    'both the impression and the copy must be tracked, or the block has no denominator'
  );
});

if (!process.exitCode) console.log('\nAll connect-automation contracts hold.');
