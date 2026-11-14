/**
 * Connect Attempted conversion guards.
 *
 * Three things here are load-bearing and none of them are visible in the Ads UI
 * if they break.
 *
 * The first is the test-account filter. The nightly journey workflow walks the
 * whole signup→activation path against PRODUCTION and is roughly 45% of the
 * OAuth consent funnel (15 of 31 oauth_consent_approved in 21 days). If the
 * filter regresses, Google Ads is trained to buy more traffic that resembles our
 * own bot, and the damage is invisible — the conversion count goes UP.
 *
 * The second is the once-guard. Onboarding data shows people copy a config
 * repeatedly before giving up (one person selected a setup path six times), so
 * without it the local funnel and the Ads number would disagree by a multiple.
 *
 * The third is that the mapping actually routes through trackProductEvent
 * rather than living at the call sites. mcp_config_copied fires from five places
 * in onboarding.tsx today; a unit test of the helper alone would stay green
 * while a sixth call site silently missed the conversion.
 *
 * Run: `tsx --test src/lib/gtag.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import './gtag.env.test';
import {
  GADS_LABELS,
  GOOGLE_ADS_ID,
  fireConnectAttemptedOnce,
  fireConversion,
  fireSignupConversionIfPending,
  markSignupPending,
  markTestAccount,
} from './gtag';

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

type Sent = { send_to?: string; value?: number };

/** Minimal window stub — localStorage plus a recording gtag. */
function installWindow() {
  const store = new Map<string, string>();
  const sent: Sent[] = [];
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    gtag: (_event: string, _name: string, params: Sent) => void sent.push(params),
  };
  return { sent, store };
}

function clearWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

test('fires once for a real account, with the Connect Attempted label and value 1', () => {
  const { sent } = installWindow();
  try {
    markTestAccount('dev@example.com');
    fireConnectAttemptedOnce();
    fireConnectAttemptedOnce();
    fireConnectAttemptedOnce();

    assert.equal(sent.length, 1, 'repeat config copies must not multiply the conversion');
    assert.equal(sent[0].send_to, `${GOOGLE_ADS_ID}/${GADS_LABELS.connectAttempted}`);
    assert.equal(sent[0].value, 1.0, 'value must match the action configured in Google Ads');
  } finally {
    clearWindow();
  }
});

test('never fires for a +clerk_test journey account', () => {
  const { sent } = installWindow();
  try {
    markTestAccount('journey+clerk_test@deerdawn.com');
    fireConnectAttemptedOnce();
    assert.equal(sent.length, 0, 'the nightly E2E run must not train Google Ads');
  } finally {
    clearWindow();
  }
});

test('a real address on the same browser clears a stale test latch', () => {
  const { sent } = installWindow();
  try {
    markTestAccount('journey+clerk_test@deerdawn.com');
    markTestAccount('real.person@example.com');
    fireConnectAttemptedOnce();
    assert.equal(sent.length, 1, 'a shared dev machine must not suppress real conversions forever');
  } finally {
    clearWindow();
  }
});

test('both connect paths route through trackProductEvent, not individual call sites', () => {
  const source = readSource('lib/productAnalytics.ts');
  assert.match(
    source,
    // No dotAll flag: a negated character class already spans newlines, and `s`
    // is not available at this tsconfig target.
    /CONNECT_ATTEMPTED_EVENTS\s*=\s*new Set\(\[[^\]]*'mcp_config_copied'[^\]]*'oauth_consent_approved'[^\]]*\]\)/,
    'both setup paths must map to the conversion — counting only one halves the signal',
  );
  assert.match(
    source,
    /CONNECT_ATTEMPTED_EVENTS\.has\(event_name\)\s*\)\s*fireConnectAttemptedOnce\(\)/,
    'the mapping must live in trackProductEvent so new call sites cannot miss it',
  );
});

test('the sign-up conversion is suppressed for a journey account', () => {
  const { sent } = installWindow();
  try {
    markTestAccount('journey+clerk_test@deerdawn.com');
    markSignupPending();
    fireSignupConversionIfPending({ accountCreatedAtMs: Date.now() });
    assert.equal(sent.length, 0, 'the nightly E2E signup must not report as a conversion');
  } finally {
    clearWindow();
  }
});

test('the guard covers every conversion, not just the ones that remembered to ask', () => {
  const { sent } = installWindow();
  try {
    markTestAccount('journey+clerk_test@deerdawn.com');
    // Stand-ins for purchase / first-sync / any action added later.
    fireConversion('SomeFutureLabel', { value: 99 });
    fireConversion(GADS_LABELS.signup, { value: 1 });
    assert.equal(sent.length, 0, 'a new conversion action must be protected by default');
  } finally {
    clearWindow();
  }
});

test('a real account still converts normally through fireConversion', () => {
  const { sent } = installWindow();
  try {
    markTestAccount('real.person@example.com');
    fireConversion('SomeLabel', { value: 7 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].value, 7);
  } finally {
    clearWindow();
  }
});

test('first sync is worth 5x connect attempted, and both labels are distinct', () => {
  assert.ok(GADS_LABELS.firstSync, 'first sync must have a label or the call is a silent no-op');
  assert.notEqual(
    GADS_LABELS.firstSync,
    GADS_LABELS.connectAttempted,
    'two conversion actions sharing a label would merge into one in Google Ads',
  );

  const source = readFileSync(
    fileURLToPath(new URL('../components/dashboard/PostSyncModal.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /fireConversion\(GADS_LABELS\.firstSync,\s*\{\s*value:\s*5(\.0)?\s*\}\)/,
    'the value must match the action configured in Google Ads — a mismatch makes value-based bidding optimise for the wrong ratio',
  );
  assert.match(
    source,
    /FIRST_SYNC_FIRED_KEY[\s\S]{0,400}?fireConversion\(GADS_LABELS\.firstSync/,
    'first sync must stay behind its once-per-browser guard',
  );
});

test('the conversion survives a failed relay to our own API', () => {
  const source = readSource('lib/productAnalytics.ts');
  assert.match(
    source,
    /\}\s*finally\s*\{[\s\S]*fireConnectAttemptedOnce\(\)/,
    'a DeerDawn API outage must not also cost us the ad attribution',
  );
});
