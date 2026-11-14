import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowFirstValueBanner } from './firstValueBanner';

const base = { isLoading: false, hasProjects: true, mcpConnected: false, hasFirstSync: false };

test('somebody with a brief and no tool ever connected is asked to connect one', () => {
  assert.equal(shouldShowFirstValueBanner(base), true);
});

test('an established user who has been idle for a month is not treated as first-run', () => {
  // mcp_registered is a 30-day window: it reads false for them. has_first_sync does not.
  assert.equal(shouldShowFirstValueBanner({ ...base, mcpConnected: false, hasFirstSync: true }), false);
});

test('a connected user, a loading page and an account with no brief never see it', () => {
  assert.equal(shouldShowFirstValueBanner({ ...base, mcpConnected: true }), false);
  assert.equal(shouldShowFirstValueBanner({ ...base, isLoading: true }), false);
  assert.equal(shouldShowFirstValueBanner({ ...base, hasProjects: false }), false);
});
