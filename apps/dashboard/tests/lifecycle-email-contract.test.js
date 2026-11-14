/**
 * Lifecycle-email attribution contracts (2026-08-15).
 *
 * The signal is produced in apps/api (the email's CTA link) and consumed in
 * apps/dashboard (_app reads it on arrival). Nothing but this file connects the
 * two, so a rename on either side would silently split the funnel into two
 * unjoinable halves — sends with no clicks, clicks with no sends — and look like
 * "the email stopped working" rather than "the contract drifted".
 *
 * Why the signal exists at all: Resend reports opens/clicks only when tracking
 * is enabled per sending DOMAIN in its dashboard, with no per-send API field, so
 * apps/api cannot turn it on. Without a self-hosted marker the activation
 * follow-up is unjudgeable — 52 sent / 14 delivered / 0 activations in the 30d
 * to 2026-08-15, with an unopened email and an opened-then-abandoned one
 * indistinguishable.
 *
 * Run: `node tests/lifecycle-email-contract.test.js` (wired into `npm test`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Comment-blind, for the reason E-019's synthetic-agent-wiring test is: every
// assertion below is about CODE, and a source-text guard that also reads prose
// fires on a doc comment that merely names the thing it forbids. That is not
// hypothetical here — E-022's comment explains why the click used to land on an
// anonymous `localStorage` uuid, and the dedupe assertion below failed on the
// explanation of the bug rather than on the bug.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const read = (rel) => stripComments(fs.readFileSync(path.resolve(root, rel), 'utf8'));

const lifecycleLib = read('src/lib/lifecycleEmail.ts');
const appFile = read('src/pages/_app.tsx');
const events = read('src/lib/analyticsEvents.ts');
const followUpJob = read('../api/src/services/email/activationFollowUp.js');

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

test('the API writes the same param name the dashboard reads', () => {
  assert(
    /dd_email:\s*emailType/.test(followUpJob),
    'activationFollowUp.js must put the email type in a dd_email param'
  );
  assert(
    lifecycleLib.includes("LIFECYCLE_EMAIL_PARAM = 'dd_email'"),
    'the dashboard must read the same param name'
  );
});

test('both variants are distinguishable, not merged into one click rate', () => {
  assert(
    followUpJob.includes("'activation_followup_connected'")
      && followUpJob.includes("'activation_followup_unconnected'"),
    'the connected/unconnected split must survive into the link'
  );
  assert(
    /dd_email.*emailTypeFor|emailTypeFor\(connected\)/s.test(followUpJob),
    'the link marker and the Resend tag must come from one helper so they cannot drift'
  );
});

test('_app captures the click, not the individual landing pages', () => {
  // Capturing centrally is what keeps onboarding.tsx out of it and makes any
  // future lifecycle email measurable without another patch.
  assert(appFile.includes('captureLifecycleEmailClick'), '_app.tsx must run the capture');
  assert(
    appFile.includes('LIFECYCLE_EMAIL_PARAM'),
    '_app.tsx must strip the marker after capture so a shared link stops re-reporting'
  );
  assert(
    /router\.replace\([^)]*shallow: true/s.test(appFile),
    'the strip must be a shallow replace — no reload, no extra history entry'
  );
});

test('the event is registered in the canonical catalogue', () => {
  assert(
    events.includes("lifecycleEmailClicked: 'lifecycle_email_clicked'"),
    'product events are referenced by constant, never hand-typed'
  );
  assert(
    lifecycleLib.includes('PRODUCT_EVENTS.lifecycleEmailClicked'),
    'the capture must use the catalogue constant'
  );
});

test('the click is deduped per email type, per browsing session', () => {
  // Once per session, not once forever: a user who comes back to the link
  // tomorrow is exactly the behaviour worth seeing.
  assert(
    lifecycleLib.includes('sessionStorage'),
    'dedupe must use sessionStorage, so it does not outlive the visit'
  );
  assert(
    !lifecycleLib.includes('localStorage'),
    'localStorage would suppress a genuine return visit'
  );
});

test('the click waits for auth before it is attributed', () => {
  // E-022 (2026-09-05). `/api/v1/product-events` is behind `optionalAuth`, so a
  // POST that beats Clerk's session resolution is accepted with a 200 and no
  // actor, and the row lands on a fresh person with one event and no
  // properties — the E-007 / E-013 phantom class, arriving once per click on
  // the one event that fires on a cold load rather than after an interaction.
  // The only lifecycle_email_clicked in the project's history has that shape.
  assert(
    /import\s*\{[^}]*\bresolveRuntimeAuthToken\b[^}]*\}\s*from\s*'@\/lib\/authToken'/.test(lifecycleLib),
    'the capture must consult the auth bridge before emitting'
  );
  assert(
    /identified/.test(lifecycleLib),
    'every click must say whether it could be joined to the emailed account'
  );
  // The deferral must never be able to drop a click: E-008 is open on this
  // event firing AT ALL, and a wait with no floor would answer that prediction
  // by breaking it.
  assert(
    lifecycleLib.includes('AUTH_WAIT_DEADLINE_MS') && /pagehide/.test(lifecycleLib),
    'the wait must be bounded by both a deadline and the page going away'
  );
});

if (process.exitCode) {
  console.error('\nLifecycle-email attribution contract broken.');
} else {
  console.log('\nLifecycle-email attribution contracts in place.');
}
