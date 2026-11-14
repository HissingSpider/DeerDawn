/**
 * The capture step offers two ways to write the first brief, and only one of
 * them could ever finish.
 *
 *   "Write it here"        -> POST /projects, 201, `seeded` -> Continue unlocks.
 *   "Or let your AI write it" -> copy a prompt, paste it into the tool, the AI
 *                             calls manage_memory, a project is created... and
 *                             Continue stayed disabled forever.
 *
 * Two independent things made the second path a dead end:
 *
 *   1. useConnectionStatus stopped polling as soon as it saw 'synced', and
 *      'synced' was `has_projects`. So the AI creating the project was the very
 *      thing that shut down the only loop that could have noticed anything
 *      afterwards. (Fixed with the connection-evidence work: the poll now stops
 *      only on has_first_sync, the terminal signal.)
 *
 *   2. `briefed` was `hasFirstSync || seeded`, and first_sync_completed is
 *      emitted on context DELIVERY, not on a write. An AI that writes the brief
 *      and does not then read one back never produces it — so even a poll that
 *      kept running had nothing to wait for in that session.
 *
 * A forward path that cannot be completed is worse than one fewer option, so
 * this pins that the offered path can finish. The unlock standard is unchanged
 * and is the one the inline path already used: a project exists on the server.
 * That is not, and must not become, a claim that anything is CONNECTED — see
 * src/lib/connectionEvidence.ts and tests/onboarding-activation-contract.test.js.
 *
 * Run: `node tests/capture-step-unlock-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const onboarding = fs.readFileSync(path.join(root, 'src/pages/onboarding.tsx'), 'utf8');

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

console.log('=== Capture Step Unlock Contracts ===\n');

const captureStep = onboarding.slice(onboarding.indexOf('function CaptureStep('));
assert.ok(captureStep.length > 0, 'CaptureStep not found');

test('the poll does not stop on anything short of the terminal signal', () => {
  const hook = onboarding.slice(
    onboarding.indexOf('function useConnectionStatus('),
    onboarding.indexOf('function useSeenOnce('),
  );
  assert.ok(hook.length > 0, 'useConnectionStatus not found');
  assert.ok(
    !/if \(next === 'synced'\) \{ done = true;/.test(hook),
    "the poll must not stop on 'synced'. It did, and 'synced' was has_projects, so " +
      'the AI creating the project shut down the loop that was watching for it.',
  );
  const stops = hook.match(/done = true;/g) || [];
  assert.equal(
    stops.length,
    1,
    `the poll should have exactly one terminal stop, found ${stops.length}. ` +
      'Every extra stop is another way for a step to be left with nothing running.',
  );
  assert.ok(
    /if \(firstSync\) \{ done = true;/.test(hook),
    'the one stop should be has_first_sync, which is durable and once per user',
  );
});

test('a brief written by the AI unlocks the step', () => {
  const briefed = captureStep.match(/const briefed = ([^;]+);/);
  assert.ok(briefed, '`briefed` is no longer computed in CaptureStep');
  assert.ok(
    /hasBrief/.test(briefed[1]),
    'Continue must unlock on a server-observed project. Without it the only way ' +
      'through this step is the inline form, and "Or let your AI write it" is an ' +
      'offer that cannot be accepted: first_sync_completed fires on context ' +
      'DELIVERY, so an AI that writes a brief and reads none back never produces it. ' +
      `Currently: ${briefed[1].trim()}`,
  );
  assert.ok(
    /hasFirstSync/.test(briefed[1]) && /seeded/.test(briefed[1]),
    'the two existing unlock signals must survive',
  );
});

test('the capture step reads the brief signal, not a connection signal', () => {
  // The fix for the other defect must not be undone by the fix for this one.
  // hasBrief is has_projects, and has_projects is not evidence of a connection.
  const hookCall = captureStep.match(/useConnectionStatus\(true\)[\s\S]{0,4}/);
  assert.ok(hookCall, 'CaptureStep should still read the poll');
  const destructured = captureStep.slice(0, captureStep.indexOf('useConnectionStatus(true)'));
  const lastConst = destructured.slice(destructured.lastIndexOf('const {'));
  assert.ok(
    !/\bstatus\b/.test(lastConst) && !/\bevidence\b/.test(lastConst),
    'the capture step must not read connection status — it is about whether a ' +
      'brief exists, and conflating the two is exactly what went wrong upstream',
  );
});

test('what unlocked the step is reported on the way out', () => {
  // onContinue(activated) feeds onboarding_completed's first_sync property, and
  // that must keep meaning first_sync_completed — a brief existing is not the
  // same claim as a brief having been delivered.
  assert.ok(
    /onContinue\(hasFirstSync\)/.test(captureStep),
    'onContinue must report hasFirstSync, not `briefed` — the funnel needs a ' +
      'completion that activated to stay distinguishable from one that only ' +
      'wrote something',
  );
});

if (process.exitCode) {
  console.error('\nCapture step unlock contracts failed.');
} else {
  console.log('\nCapture step unlock contracts in place.');
}
