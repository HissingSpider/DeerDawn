/**
 * What /onboarding is allowed to show before there is an account.
 *
 * The whole change rests on one claim — that the connector URL and the setup
 * command are identical for every user — so that claim is what this file
 * checks, not the wording around it. If a per-account value is ever
 * interpolated into either, or either drifts from what the signed-in step
 * renders, the preview stops being a preview and starts being a lie that costs
 * the reader a second copy-paste.
 *
 * Run: `npx tsx --test src/lib/onboardingPreview.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SETUP_PROMPT,
  ONE_COMMAND_SETUP,
  REMOTE_MCP_URL,
  REMOTE_SETUP_LOCATIONS,
} from './connectCopy';
import {
  PREVIEW_LOCATIONS,
  PREVIEW_SETUP,
  PREVIEW_SIGNIN_ROUTE,
  PREVIEW_SIGNUP_ROUTE,
  WHAT_SIGNING_IN_ADDS,
  isAccountAgnostic,
} from './onboardingPreview';

const valueOf = (id: string) => PREVIEW_SETUP.find((item) => item.id === id)?.value;

// ── The values are real ──────────────────────────────────────────────────────

test('the preview shows the same strings the signed-in step does', () => {
  // Not "equivalent" — the same exports. A second copy of the URL would drift
  // exactly the way the marketing/dashboard connect copy drifted, and here the
  // drift is invisible: both pages render something URL-shaped and only one of
  // them works.
  assert.equal(valueOf('connector_url'), REMOTE_MCP_URL);
  assert.equal(valueOf('one_command'), ONE_COMMAND_SETUP);
  assert.deepEqual(PREVIEW_LOCATIONS, REMOTE_SETUP_LOCATIONS);
});

test('nothing in the preview is a placeholder', () => {
  // The failure this rules out: a plausible-looking sample the reader copies,
  // pastes, and cannot distinguish from the real one they were supposed to come
  // back for. Every value has to be usable as printed.
  for (const item of PREVIEW_SETUP) {
    assert.ok(item.value.length > 0, `${item.id} renders an empty value`);
    assert.ok(
      isAccountAgnostic(item.value),
      `${item.id} carries something account-scoped or unresolved: ${item.value}`,
    );
    for (const marker of ['example', 'your-', 'YOUR_', 'xxxx', 'placeholder', 'TODO', '...']) {
      assert.ok(
        !item.value.toLowerCase().includes(marker.toLowerCase()),
        `${item.id} looks like a sample rather than the real value (${marker})`,
      );
    }
  }
});

test('the URL is one hosted server, not a per-account endpoint', () => {
  // The reason this page can be shown to a stranger at all. Identity is
  // established by the browser OAuth round trip the tool performs on connect,
  // not by the string being pasted — so the string has no account in it.
  const url = new URL(String(valueOf('connector_url')));
  assert.equal(url.search, '', 'a query string on the connector URL is where a token would hide');
  assert.equal(url.username, '', 'credentials in the URL');
  assert.equal(url.password, '', 'credentials in the URL');
  assert.ok(!/\d{4,}/.test(url.pathname), 'the path carries an id-looking segment');
});

test('the account-scoping guard actually catches the shapes it names', () => {
  // A guard that passes everything is worse than none: it reads as a check.
  assert.equal(isAccountAgnostic('https://api.deerdawn.com/mcp'), true);
  assert.equal(isAccountAgnostic('npx -y @deerdawn/mcp-server@latest setup'), true);

  for (const scoped of [
    'https://api.deerdawn.com/mcp?api_key=abc123',
    'https://api.deerdawn.com/mcp/org_2fJq8s',
    'https://api.deerdawn.com/mcp/3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'claude mcp add deerdawn --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x"',
    'DEERDAWN_USER=someone@example.com npx @deerdawn/mcp-server',
    'https://api.deerdawn.com/mcp/${workspace}',
    'https://api.deerdawn.com/mcp/YOUR_WORKSPACE',
  ]) {
    assert.equal(isAccountAgnostic(scoped), false, `not caught: ${scoped}`);
  }
});

// ── It says where it stops ───────────────────────────────────────────────────

test('the preview names the step the paste cannot finish', () => {
  // Copying the URL gets the reader to an authorization screen and no further.
  // Discovering that AT the screen is the version of this page that wastes
  // someone's time; saying it here is the version that does not.
  assert.ok(WHAT_SIGNING_IN_ADDS.length > 0, 'the preview no longer says what an account is for');
  const first = WHAT_SIGNING_IN_ADDS[0].toLowerCase();
  assert.ok(
    first.includes('authorize') || first.includes('authorise'),
    'the first thing said about an account should be the authorization step, because that is ' +
      `the one the reader hits within a minute of copying: ${WHAT_SIGNING_IN_ADDS[0]}`,
  );
  assert.ok(
    WHAT_SIGNING_IN_ADDS.join(' ').toLowerCase().includes('account'),
    'the requirement is never actually named',
  );
});

test('the preview does not offer the path that strands a signed-out reader', () => {
  // AGENT_SETUP_PROMPT tells the reader's AI to install AND connect DeerDawn end
  // to end. With no account it runs straight into an OAuth screen with nothing
  // to authorize against, mid-install, having already edited their config. The
  // URL and the command stop cleanly and say so; this one does not.
  const rendered = [
    ...PREVIEW_SETUP.map((item) => `${item.label} ${item.value} ${item.detail}`),
    ...WHAT_SIGNING_IN_ADDS,
  ].join('\n');
  assert.ok(
    !rendered.includes(AGENT_SETUP_PROMPT),
    'the agent setup prompt is being offered before there is an account to authorize',
  );
});

// ── The way back ─────────────────────────────────────────────────────────────

test('both routes out land the reader back on this flow', () => {
  // A preview that sends someone to a signup form which then drops them on the
  // dashboard has spent the intent it just created.
  assert.equal(PREVIEW_SIGNUP_ROUTE, '/signup', 'signup already defaults its post-signup hop to /onboarding');
  assert.match(
    PREVIEW_SIGNIN_ROUTE,
    /^\/login\?redirect_url=/,
    'the sign-in link must carry a redirect — /login alone lands on Today',
  );
  assert.equal(
    new URLSearchParams(PREVIEW_SIGNIN_ROUTE.split('?')[1]).get('redirect_url'),
    '/onboarding',
    'the sign-in redirect must come back here, and must be encoded so it survives the round trip',
  );
});
