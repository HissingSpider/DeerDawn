const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

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

console.log('=== Dashboard UI Availability Regression Tests ===\n');

// `/` became Today on 2026-08-27; the brief — and with it the first-value
// banner — moved to `/projects`. Both are read, so each assertion can point at
// the file that now owns the behaviour it describes.
const homePage = read('src/pages/index.tsx');
const briefPage = read('src/pages/projects.tsx');
// The redesign folded settings/tools into the single /setup page. Same content,
// same contract — just a different file.
const toolsPage = read('src/pages/setup.tsx');
const connectCopy = read('src/lib/connectCopy.ts');
const settingsPage = read('src/pages/settings.tsx');
const topNav = read('src/components/layout/TopNav.tsx');
const selectPlan = read('src/pages/select-plan.tsx');
const globalsCss = read('src/styles/globals.css');

test('dashboard home should not show quickstart or workspace shortcut buttons', () => {
  assert(!homePage.includes('Open workspace →'), 'dashboard home still shows the workspace shortcut');
  assert(!homePage.includes('Open quickstart →'), 'dashboard home still shows the quickstart shortcut');
});

test('a brief line renders whichever timestamp its slot actually stamps', () => {
  // Each slot stamps a different field: decisions decided_at, shipped
  // shipped_at, landmines added_at. BriefLine read decided_at alone, so SHIPPED
  // and LANDMINE lines rendered with no date — alongside the mapping bug that
  // left shipped cards with no text either (see lib/briefSpine.test.ts).
  const line = read('src/components/dashboard/brief/BriefLine.tsx');
  for (const field of ['decided_at', 'shipped_at', 'added_at']) {
    assert(line.includes(field), `BriefLine must consider ${field} when rendering a date`);
  }
});

test('the brief page should hide the first-value banner once MCP is connected or no brief exists', () => {
  // WHEN the banner shows is pinned as behaviour in
  // src/lib/firstValueBanner.test.ts. This used to grep for the literal guard
  // `if (isLoading || !hasProjects || mcpConnected) return null;`, which is the
  // line that told a 30-day-idle user to "Connect an AI tool" — so the test
  // would have failed the fix and passed the bug. What is left here is only that
  // the page still routes the decision through that one function.
  assert(
    briefPage.includes('shouldShowFirstValueBanner('),
    'the brief page no longer asks lib/firstValueBanner whether to show the first-value banner'
  );
});

test('dashboard home is Today and does not carry a second first-run banner', () => {
  // Today already answers the empty case with its own hero. A second banner on
  // the landing page would be two first-run surfaces competing on the first
  // screen a new account ever sees, which is what FirstValueBanner was narrowed
  // to avoid in the first place.
  assert(!homePage.includes('FirstValueBanner'), 'Today should not also render the first-value banner');
  // The CTA's words and destination now come from CONNECT_CTA_LABEL /
  // CONNECT_ROUTE in lib/todayConnection, because the page had grown a SECOND
  // "Connect a tool" — same words, different route — in the connection strip's
  // empty branch. This assertion keeps its original meaning (there is a route
  // out); the "exactly one of them" half is next door in
  // tests/today-page-contract.test.js, which can count.
  assert(homePage.includes('CONNECT_CTA_LABEL'), 'Today still needs a route out for an unconnected account');
});

test('tools settings should show OAuth-first remote MCP web tools', () => {
  assert(!toolsPage.includes("claude_web: 'Claude (web)'"), 'setup page still exposes legacy Claude web');
  assert(!toolsPage.includes("chatgpt_web: 'ChatGPT (web)'"), 'setup page still exposes legacy ChatGPT web');
  assert(toolsPage.includes("name: 'Claude.ai'"), 'setup page is missing Claude.ai remote MCP setup');
  assert(toolsPage.includes("name: 'ChatGPT.com'"), 'setup page is missing ChatGPT.com remote MCP setup');
  assert(connectCopy.includes('`${DEERDAWN_API_URL}/mcp`'), 'tools copy is missing the canonical remote MCP URL');
  // The steps moved into connectCopy (connectorSetupSteps) so /setup, /connect
  // and onboarding stop naming three different menus. What they say is asserted
  // on the imported values in src/lib/connectCopy.test.ts; this only checks the
  // page still takes them from there instead of typing its own.
  assert(toolsPage.includes("connectorSetupSteps('Claude.ai')"), 'setup page no longer takes the Claude.ai steps from connectCopy');
  assert(toolsPage.includes("connectorSetupSteps('ChatGPT.com')"), 'setup page no longer takes the ChatGPT.com steps from connectCopy');
  assert(!toolsPage.includes('Bearer token authentication'), 'setup page still promotes manual bearer-token setup');
});

test('settings page should only show current CLI and MCP surfaces', () => {
  assert(!settingsPage.includes('GitHub Copilot'), 'settings page still lists GitHub Copilot');
  assert(!settingsPage.includes('Gemini CLI'), 'settings page still lists Gemini CLI');
  assert(!settingsPage.includes('Managed Agent'), 'settings page still lists Claude web managed agent');
  assert(!settingsPage.includes('Tampermonkey userscript'), 'settings page still lists web userscript integrations');
  assert(!settingsPage.includes('ChatGPT (chatgpt.com)'), 'settings page still lists ChatGPT web');
});

test('top navigation should not link to standalone integrations settings', () => {
  assert(!topNav.includes('href="/settings/integrations"'), 'top navigation still links to settings integrations');
});

test('select plan modal should constrain height and create its own scroll container', () => {
  assert(
    selectPlan.includes('max-h-[calc(100dvh-2rem)]') &&
      selectPlan.includes('min-h-0 overflow-y-auto'),
    'select plan modal is missing its constrained, scrollable layout'
  );
});

test('dashboard fullbleed content should allow flex overflow scrolling', () => {
  assert(
    /\.dashboard-content-fullbleed\s*{[^}]*min-height:\s*0;/s.test(globalsCss),
    'dashboard fullbleed content is missing min-height: 0 for reliable internal scrolling'
  );
});

test('standalone setup pages should render outside the dashboard shell', () => {
  const app = read('src/pages/_app.tsx');
  assert(app.includes("router.pathname === '/select-plan'"), 'select-plan is not marked as a standalone authed page');
  assert(app.includes("router.pathname === '/checkout'"), 'checkout is not marked as a standalone authed page');
  assert(app.includes("router.pathname === '/onboarding'"), 'onboarding is not marked as a standalone authed page');
  assert(app.includes('isStandaloneAuthedPage'), 'standalone authed page routing flag is missing');
});

test('modal body should scroll when settings content exceeds viewport', () => {
  assert(
    /\.modal-card\s*{[^}]*max-height:/s.test(globalsCss),
    'modal card is missing max-height'
  );
  assert(
    /\.modal-body\s*{[^}]*overflow-y:\s*auto;/s.test(globalsCss),
    'modal body is missing overflow-y auto'
  );
});

// "Reload to retry" is an instruction, not an affordance: the reader has to act
// on it, and a full reload re-runs the whole shell to repeat one request. The
// failure is almost always a dropped connection, so the page should offer the
// retry itself and take it automatically once the browser is back online.
test('portfolio load failure should offer a retry rather than instructing a reload', () => {
  const portfolio = read('src/pages/portfolio.tsx');
  assert(portfolio.includes('InlineErrorState'), 'portfolio error state should use the shared InlineErrorState');
  assert(portfolio.includes('onRetry='), 'portfolio error state is missing a retry action');
  assert(
    portfolio.includes("addEventListener('online'"),
    'portfolio should retry automatically when the connection returns'
  );
  assert(
    !portfolio.includes('Reload to retry'),
    'portfolio error state still instructs a manual page reload'
  );
});

if (process.exitCode) {
  console.error('\nDashboard UI availability regressions detected.');
} else {
  console.log('\nDashboard UI availability contracts in place.');
}
