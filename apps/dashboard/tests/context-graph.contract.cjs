const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The redesign replaced /context/context-graph with the single /memory page.
// The contract that still matters is that the graph inspector EXISTS, is
// reachable from the nav, and is backed by the two context-graph API calls.
// The old three-layer taxonomy labels ("Direct context" / "Passive enrichment" /
// "Intelligence layer") were deliberately dropped with that page and are not
// asserted any more.
const pagePath = path.join(__dirname, '..', 'src', 'pages', 'memory.tsx');
const apiPath = path.join(__dirname, '..', 'src', 'lib', 'api.ts');
const navPath = path.join(__dirname, '..', 'src', 'components', 'layout', 'TopNav.tsx');

test('dashboard exposes a context graph inspector page and nav entry', () => {
  assert.ok(fs.existsSync(pagePath), 'memory (context graph) page is missing');

  const apiSource = fs.readFileSync(apiPath, 'utf8');
  assert.match(apiSource, /getContextProjects/);
  assert.match(apiSource, /getContextProjectGraph/);

  const pageSource = fs.readFileSync(pagePath, 'utf8');
  assert.match(pageSource, /Context Graph/);
  assert.match(pageSource, /getContextProjectGraph/, 'memory page should load the project graph');
  assert.match(pageSource, /Search memory/, 'memory page should expose search over the graph');

  const navSource = fs.readFileSync(navPath, 'utf8');
  assert.match(navSource, /href: '\/memory'/, 'nav is missing the Memory entry');
});
