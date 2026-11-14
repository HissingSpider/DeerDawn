/**
 * Lifecycle-email click attribution (2026-08-15).
 *
 * The activation follow-up is the product's only second touch and it has never
 * been judgeable: 52 sent, 14 confirmed delivered, 0 resulting activations in
 * the 30d to 2026-08-15, with "nobody opened it" and "everybody opened it and
 * the landing page lost them" producing the same zero. Resend reports
 * opens/clicks only when tracking is enabled per sending DOMAIN in its
 * dashboard, so apps/api cannot switch it on — the click is measured on arrival
 * instead.
 *
 * Run: `tsx --test src/lib/lifecycleEmail.test.ts` (wired into `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';

import { readLifecycleEmailType, LIFECYCLE_EMAIL_PARAM } from './lifecycleEmail';

test('reads the marker the API actually sends', () => {
  assert.equal(LIFECYCLE_EMAIL_PARAM, 'dd_email');
  assert.equal(
    readLifecycleEmailType({ dd_email: 'activation_followup_unconnected' }),
    'activation_followup_unconnected',
  );
  assert.equal(
    readLifecycleEmailType({ dd_email: 'activation_followup_connected' }),
    'activation_followup_connected',
  );
});

test('takes the first value when Next hands back a repeated param', () => {
  // Repeated query keys arrive as arrays; #300 dedupes them upstream, but this
  // must not depend on that.
  assert.equal(
    readLifecycleEmailType({ dd_email: ['activation_followup_connected', 'x'] }),
    'activation_followup_connected',
  );
});

test('ignores anything that is not a plain tag value', () => {
  // A hand-edited link must not be able to write arbitrary strings into the
  // funnel. The charset matches Resend's tag rules, so a value that survives
  // here is one the send side could also have produced.
  for (const bad of [
    undefined,
    '',
    'has space',
    'semi;colon',
    '<script>',
    'a'.repeat(65),
  ] as (string | undefined)[]) {
    assert.equal(readLifecycleEmailType({ dd_email: bad }), undefined, `rejected: ${String(bad)}`);
  }
  assert.equal(readLifecycleEmailType({}), undefined);
});

/**
 * E-022 (2026-09-05): the emit is deferred until the auth bridge answers.
 *
 * `/api/v1/product-events` is mounted behind `optionalAuth`, so a POST that
 * beats Clerk's session resolution is accepted with a 200 and no actor, and
 * `productEventsService` files it under the dashboard's localStorage uuid — a
 * fresh PostHog person with one event and no properties, unjoinable to the
 * account that was emailed. This event is the only dashboard product event that
 * fires on a cold load, so it is the only one that loses that race by default.
 *
 * These tests exercise the rule as logic, through the injected deps, rather
 * than pinning the call site's source text.
 */

import {
  emitLifecycleEmailClick,
  AUTH_WAIT_DEADLINE_MS,
  AUTH_POLL_INTERVAL_MS,
  type LifecycleEmailDeps,
} from './lifecycleEmail';

type Emitted = { event: string; payload: Record<string, unknown> };

/**
 * Deterministic clock: `sleep` advances virtual time instead of waiting, so a
 * test of an eight-second deadline runs in microseconds and never flakes.
 */
function harness(overrides: Partial<LifecycleEmailDeps> = {}) {
  const emitted: Emitted[] = [];
  const pageHideListeners: Array<() => void> = [];
  let clock = 0;
  const deps: LifecycleEmailDeps = {
    track: (event, payload) => emitted.push({ event, payload }),
    resolveToken: async () => null,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onPageHide: (fn) => {
      pageHideListeners.push(fn);
      return () => {
        const i = pageHideListeners.indexOf(fn);
        if (i >= 0) pageHideListeners.splice(i, 1);
      };
    },
    ...overrides,
  };
  return {
    deps,
    emitted,
    hidePage: () => pageHideListeners.forEach((fn) => fn()),
    listenerCount: () => pageHideListeners.length,
  };
}

function metadata(row: Emitted): Record<string, unknown> {
  return row.payload.metadata as Record<string, unknown>;
}

test('waits for the token, then emits the click as identified', async () => {
  // The bridge answers on the third poll — the shape of a cold load where
  // Clerk's script is still resolving when _app's first effect runs.
  let calls = 0;
  const h = harness({
    resolveToken: async () => {
      calls += 1;
      return calls >= 3 ? 'tok_live' : null;
    },
  });

  const identified = await emitLifecycleEmailClick('activation_followup_unconnected', '/setup', h.deps);

  assert.equal(identified, true);
  assert.equal(h.emitted.length, 1, 'exactly one event');
  assert.equal(h.emitted[0].event, 'lifecycle_email_clicked');
  assert.equal(metadata(h.emitted[0]).identified, true);
  assert.equal(metadata(h.emitted[0]).email_type, 'activation_followup_unconnected');
  // Two polls' worth of waiting, not eight seconds of it.
  assert.equal(metadata(h.emitted[0]).auth_wait_ms, AUTH_POLL_INTERVAL_MS * 2);
});

test('emits anyway at the deadline rather than losing the click', async () => {
  // A genuinely signed-out arrival, or a Clerk script that never loads. E-008's
  // open prediction is that this event fires AT ALL; a deferral that could drop
  // it would break the thing it is trying to measure.
  const h = harness();

  const identified = await emitLifecycleEmailClick('activation_followup_connected', '/setup', h.deps);

  assert.equal(identified, false);
  assert.equal(h.emitted.length, 1);
  assert.equal(metadata(h.emitted[0]).identified, false);
  assert.ok(
    (metadata(h.emitted[0]).auth_wait_ms as number) >= AUTH_WAIT_DEADLINE_MS,
    'waited the full deadline before giving up',
  );
});

test('emits immediately when the page is going away', async () => {
  // The user clicks through before Clerk answers. Waiting would lose the row;
  // the POST is keepalive, so emitting here still lands.
  const h = harness({
    resolveToken: async () => {
      h.hidePage();
      return null;
    },
  });

  const identified = await emitLifecycleEmailClick('activation_followup_unconnected', '/setup', h.deps);

  assert.equal(identified, false);
  assert.equal(h.emitted.length, 1);
  assert.ok(
    (metadata(h.emitted[0]).auth_wait_ms as number) < AUTH_WAIT_DEADLINE_MS,
    'did not sit out the deadline once the page was gone',
  );
});

test('a throwing auth bridge is not read as signed out', async () => {
  // A failed token fetch and a signed-out session are different answers, and
  // api.ts already carries that distinction. Treating a throw as "no session"
  // would emit an unattributed click on a user who is in fact signed in.
  let calls = 0;
  const h = harness({
    resolveToken: async () => {
      calls += 1;
      if (calls === 1) throw new Error('clerk script died');
      return 'tok_live';
    },
  });

  assert.equal(await emitLifecycleEmailClick('activation_followup_unconnected', '/setup', h.deps), true);
  assert.equal(metadata(h.emitted[0]).identified, true);
});

test('the page-hide listener is always removed', async () => {
  // A listener left behind on every lifecycle click would leak across the SPA's
  // whole session.
  const h = harness({ resolveToken: async () => 'tok_live' });
  await emitLifecycleEmailClick('activation_followup_unconnected', '/setup', h.deps);
  assert.equal(h.listenerCount(), 0);
});
