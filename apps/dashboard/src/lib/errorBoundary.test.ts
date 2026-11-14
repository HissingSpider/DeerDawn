/**
 * The boundary's state machine, run for real.
 *
 * `getDerivedStateFromError` and `getDerivedStateFromProps` are static and
 * pure, so they can be called directly — no renderer, no DOM. That matters
 * here because the bug being pinned is not "the fallback looks wrong", it is
 * "the boundary never lets go of an error it caught", and that is a state
 * transition, not a render tree.
 *
 * The structural half (WHERE the boundary is mounted) is in
 * `tests/error-boundary-contract.test.js`; the two only mean something
 * together. A boundary that resets correctly but wraps the whole app still
 * blanks the dashboard, and a well-placed boundary that never resets leaves a
 * dead panel behind on every subsequent route.
 *
 * Run: `tsx --test src/lib/errorBoundary.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ErrorBoundary } from '@/components/ErrorBoundary';

type BoundaryState = {
  hasError: boolean;
  error: Error | null;
  retryFailed: boolean;
  lastResetKey: string | number | undefined;
};

/** The state a freshly-constructed boundary carries. */
const FRESH: BoundaryState = {
  hasError: false,
  error: null,
  retryFailed: false,
  lastResetKey: undefined,
};

// React merges whatever the static hooks return into the current state; these
// helpers do the same, so a sequence of calls reads like the real lifecycle.
const Boundary = ErrorBoundary as unknown as {
  getDerivedStateFromError(error: Error): Partial<BoundaryState>;
  getDerivedStateFromProps(
    props: { resetKey?: string | number },
    state: BoundaryState,
  ): Partial<BoundaryState> | null;
};

function afterCatch(state: BoundaryState, error: Error): BoundaryState {
  return { ...state, ...Boundary.getDerivedStateFromError(error) };
}

function afterRender(state: BoundaryState, props: { resetKey?: string | number }): BoundaryState {
  return { ...state, ...(Boundary.getDerivedStateFromProps(props, state) || {}) };
}

test('a caught error puts the boundary into its fallback', () => {
  const crash = new Error('Cannot read properties of undefined');
  const state = afterCatch(FRESH, crash);

  assert.equal(state.hasError, true);
  assert.equal(state.error, crash, 'the error itself is kept — the dev-only details render it');
});

test('a route change clears the error, so navigating away actually recovers', () => {
  // THE BUG. Scoping the boundary to the routed page is only half the fix: a
  // boundary holds its caught error until something clears it, so without this
  // the user would click a working nav link and be shown the PREVIOUS page's
  // crash on the new route — a worse failure than the full-screen one, because
  // now the app looks broken everywhere.
  let state = afterRender(FRESH, { resetKey: '/dashboard' });
  state = afterCatch(state, new Error('boom'));
  assert.equal(state.hasError, true);

  state = afterRender(state, { resetKey: '/settings' });

  assert.equal(state.hasError, false, 'navigating to /settings must clear /dashboard’s crash');
  assert.equal(state.error, null);
  assert.equal(state.lastResetKey, '/settings');
});

test('re-rendering the SAME route does not clear the error', () => {
  // The counterpart risk: if any render cleared the error, the boundary would
  // immediately re-render the crashing child, throw, and loop — which is what
  // the old "Try Again" button did on every click.
  let state = afterRender(FRESH, { resetKey: '/dashboard' });
  state = afterCatch(state, new Error('boom'));

  state = afterRender(state, { resetKey: '/dashboard' });

  assert.equal(state.hasError, true, 'a same-route re-render must not silently retry the crash');
});

test('a query-string-only change counts as a new route', () => {
  // Layout keys on `router.asPath`, which carries the query. A page that
  // crashed on `?tab=graph` may render fine on `?tab=list`, and the user gets
  // there by clicking, not navigating away.
  let state = afterRender(FRESH, { resetKey: '/portfolio?tab=graph' });
  state = afterCatch(state, new Error('boom'));

  state = afterRender(state, { resetKey: '/portfolio?tab=list' });

  assert.equal(state.hasError, false);
});

test('with no resetKey the boundary holds its error — the outer, shell-less case', () => {
  // The app-root boundary in _app.tsx deliberately passes none: everything that
  // could navigate you out died with it, so there is no key that means
  // "recovered". It must not decide it has recovered on its own.
  let state = afterRender(FRESH, {});
  state = afterCatch(state, new Error('provider died'));

  state = afterRender(state, {});
  state = afterRender(state, {});

  assert.equal(state.hasError, true);
});

test('a route change also clears retryFailed, so the next page is offered a retry', () => {
  // retryFailed is a statement about ONE crash ("retrying reproduced it"). It
  // must not travel to the next page, or an unrelated later failure would show
  // the give-up copy and withhold the button that might have worked.
  let state = afterRender(FRESH, { resetKey: '/dashboard' });
  state = { ...afterCatch(state, new Error('boom')), retryFailed: true };

  state = afterRender(state, { resetKey: '/settings' });

  assert.equal(state.retryFailed, false);
});
