const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'components', 'dashboard', 'ContextNetwork.tsx');
const source = fs.readFileSync(file, 'utf8');

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

console.log('=== Context Network Jitter Regression Tests ===\n');

// This suite used to pin the constants of a force-directed intro animation
// (MAX_INITIAL_JITTER_MS, settleFrames, an RAF deadline). 60ead5cc replaced that
// graph with a static expandable org-chart tree, so those constants are gone and
// asserting them only produced a permanently red test.
//
// The INTENT still matters: opening the graph must not kick off a settling
// animation that jitters, especially on dense graphs. A static layout satisfies
// that structurally, so the guard is now "no animation loop at all" — which
// fails loudly if a physics simulation is ever reintroduced without revisiting
// the jitter problem it caused the first time.
test('graph renders without an animation loop, so there is no intro jitter to cap', () => {
  assert(
    !/requestAnimationFrame|cancelAnimationFrame/.test(source),
    'ContextNetwork reintroduced an animation loop — re-establish an intro motion cap before shipping it'
  );
  assert(
    !/settleFrames|introAnimationDeadline|INITIAL_JITTER/.test(source),
    'ContextNetwork reintroduced force-simulation settling state'
  );
});

test('graph layout is computed statically from the tree', () => {
  assert(
    /useMemo/.test(source),
    'ContextNetwork should derive its layout in render, not from mutable animation state'
  );
});

if (process.exitCode) {
  console.error('\nContext network jitter regressions detected.');
} else {
  console.log('\nContext network jitter contracts in place.');
}
