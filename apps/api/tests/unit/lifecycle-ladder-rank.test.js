const test = require('node:test');
const assert = require('node:assert');

const segments = require('../../src/services/email/lifecycleSegments');

/**
 * The setup ladder's ordering, pinned.
 *
 * LADDER_RANK is a bare object literal that reads as decoration and is in fact
 * load-bearing: conciergeRecovery.js derives "how far did this person get?" from
 * it and then says that out loud, by email, to a stranger. Nothing else asserts
 * its shape, so a plausible-looking edit to it is a silent change to what a
 * campaign claims about someone's machine.
 *
 * These pin the two things that can go wrong:
 *   1. a rung collapsing two genuinely different accounts back together, and
 *   2. a renumber that shifts a rung out from under a hard-coded comparison
 *      somewhere else in the tree.
 */

const rank = (name) => {
  const r = segments.LADDER_RANK[name];
  assert.notEqual(r, undefined, `${name} has no rung — every ladder event needs one`);
  return r;
};

test('a handshake ranks strictly below actually calling us', () => {
  // The distinction three of eight connected accounts sit on: `mcp_runtime_started`
  // is written from the `initialize` handshake alone, so it means "installed and
  // silent". The other two are only ever written after a tool really ran. While
  // they shared a rung, the file that calls itself the one definition of the
  // ladder could not tell those two populations apart.
  const handshake = rank('mcp_runtime_started');

  for (const called of ['mcp_start_session_succeeded', 'mcp_tool_call_succeeded']) {
    assert.ok(
      handshake < rank(called),
      `mcp_runtime_started (${handshake}) must rank BELOW ${called} (${rank(called)}) — `
      + 'a client that connected and never called a tool has not got as far as one that did',
    );
  }
});

test('the two call events stay tied to each other, on purpose', () => {
  // Same step by different routes, which is the shared-rung convention the file
  // already uses. If these ever need splitting it should be a deliberate edit
  // with a reason, not a side effect of renumbering around them.
  assert.equal(
    rank('mcp_start_session_succeeded'),
    rank('mcp_tool_call_succeeded'),
    'both mean "the model invoked a tool"; nothing downstream distinguishes them',
  );
});

test('the runtime rungs sit strictly between connecting and activating', () => {
  // Guards the block from either neighbour absorbing it: a runtime event that
  // sinks to the setup rungs would make a working install look stuck, and one
  // that floats to the activation rungs would make a silent install look alive.
  const connected = rank('onboarding_connection_detected');
  const activationRanks = segments.ACTIVATION_EVENTS.map(rank);

  for (const name of segments.RUNTIME_EVENTS) {
    assert.ok(connected < rank(name), `${name} must outrank onboarding_connection_detected`);
    for (const activated of activationRanks) {
      assert.ok(
        rank(name) < activated,
        `${name} must rank below every activation event — a session is not a delivered brief`,
      );
    }
  }
});

test('the rungs other files hard-code by NUMBER have not moved', () => {
  // conciergeRecovery.js gates hypotheses on `rank <= 6` and `rank === 3` and
  // keys STEP_PHRASE by rank number. Those comparisons carry no event names, so
  // renumbering the ladder downward to make room for a new rung would move the
  // consent step out from under them without failing anything else. This is the
  // test that fails instead.
  assert.equal(rank('setup_path_selected'), 3, 'the `rank === 3` picker hypothesis reads this rung');
  assert.equal(rank('setup_path_changed'), 3, 'and its sibling shares it');

  const atOrBelowSix = Object.entries(segments.LADDER_RANK)
    .filter(([, r]) => r <= 6)
    .map(([name]) => name)
    .sort();

  assert.deepEqual(atOrBelowSix, [
    'account_created',
    'mcp_config_copied',
    'mcp_connection_tested',
    'mcp_setup_viewed',
    'oauth_consent_approved',
    'oauth_consent_failed',
    'oauth_consent_signin_required',
    'oauth_consent_viewed',
    'onboarding_page_viewed',
    'setup_path_changed',
    'setup_path_selected',
  ], 'the set of events `rank <= 6` selects is frozen — widening it silently changes who is told what');

  assert.equal(rank('onboarding_connection_detected'), 7, 'the first rung above that guard');
});

test('every cohort event has a rung, and LADDER_EVENTS covers them all', () => {
  // LADDER_EVENTS is the query surface: an event with no rung is invisible to
  // the diagnosis, and a rung with no cohort is unreachable. Both are silent.
  const cohorts = [
    ...segments.SETUP_ATTEMPT_EVENTS,
    ...segments.RUNTIME_EVENTS,
    ...segments.ACTIVATION_EVENTS,
  ];

  for (const name of cohorts) {
    rank(name);
    assert.ok(segments.LADDER_EVENTS.includes(name), `${name} must be queryable via LADDER_EVENTS`);
  }

  assert.deepEqual(
    segments.LADDER_EVENTS.slice().sort(),
    Object.keys(segments.LADDER_RANK).sort(),
    'LADDER_EVENTS is derived from LADDER_RANK and must stay so',
  );
});

test('every activation event outranks every setup attempt', () => {
  // The structural claim in the file header — dormant / stuck / working are
  // complements of one ordered ladder, not three hand-maintained lists.
  const highestAttempt = Math.max(...segments.SETUP_ATTEMPT_EVENTS.map(rank));
  for (const name of segments.ACTIVATION_EVENTS) {
    assert.ok(highestAttempt < rank(name), `${name} must outrank every setup-attempt event`);
  }
});
