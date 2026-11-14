import test from 'node:test';
import assert from 'node:assert';

import { usagePlanLine } from './usagePlanLine';

test('Free with no project cap (limits.projects: null) says unlimited, not "3 workspaces"', () => {
  const line = usagePlanLine({ isFreeTier: true, planLabel: 'Free', historyDays: 90, projectLimit: null });
  assert.strictEqual(line, 'Free remembers the last 90 days across unlimited workspaces.');
  assert.doesNotMatch(line, /\b3 workspaces\b/);
});

test('a real cap is still stated as the number it is', () => {
  assert.strictEqual(
    usagePlanLine({ isFreeTier: true, planLabel: 'Free', historyDays: 90, projectLimit: 1 }),
    'Free remembers the last 90 days in one workspace.',
  );
  assert.strictEqual(
    usagePlanLine({ isFreeTier: true, planLabel: 'Free', historyDays: 30, projectLimit: 5 }),
    'Free remembers the last 30 days in 5 workspaces.',
  );
});

test('an unknown history window is not filled in with a made-up number', () => {
  const line = usagePlanLine({ isFreeTier: true, planLabel: 'Free', historyDays: null, projectLimit: null });
  assert.doesNotMatch(line, /\d/);
});

test('paid plans: no meters, and no em dash in UI copy', () => {
  const line = usagePlanLine({ isFreeTier: false, planLabel: 'Pro', historyDays: null, projectLimit: null });
  assert.strictEqual(line, 'Unlimited projects and permanent memory. Nothing on Pro runs out.');
  assert.doesNotMatch(line, /—/);
});
