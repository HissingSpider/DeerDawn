const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function read(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

test('dashboard launch shell stays focused on MCP-first activation and context sync', () => {
  const source = read('src', 'pages', 'index.tsx');

  assert.doesNotMatch(source, /Install Chrome extension/);
  assert.doesNotMatch(source, /chromewebstore/i);
  // The redesign cut Overview down to the Brief, so its "First value / one
  // connected tool / one confirmed sync" checklist copy is gone. What still
  // has to be true is that the landing shell is the brief, not a desktop or
  // extension pitch.
  assert.match(source, /Brief|brief/, 'dashboard index should lead with the brief');
});

test('dashboard onboarding and plan copy describe an MCP-first context-sync product', () => {
  const onboarding = read('src', 'pages', 'onboarding.tsx');
  const selectPlan = read('src', 'pages', 'select-plan.tsx');
  const appShell = read('src', 'components', 'dashboard', 'AppShell.tsx');
  const authProvider = read('src', 'components', 'layout', 'AuthProvider.tsx');
  const api = read('src', 'lib', 'api.ts');

  assert.match(onboarding, /(MCP|context sync|workspace)/i);
  assert.doesNotMatch(selectPlan, /Chrome extension/i);
  // No third argument: an invite code is applied while the account is created
  // and PATCH /orgs/account-type refuses one (`referral_signup_only`), so this
  // onboarding handoff must not carry a code. Pinned so it cannot creep back.
  assert.match(selectPlan, /updateAccountType\(accountType, planId\)/);
  assert.match(selectPlan, /updateAccountType\(accountType, undefined\)/);
  assert.doesNotMatch(selectPlan, /updateAccountType\([^)]*referralCode/);
  assert.doesNotMatch(appShell, /Personal workspaces are no longer supported/i);
  assert.doesNotMatch(appShell, /retired personal plan/i);
  assert.match(authProvider, /Session restore/);
  // MinimalSpinner was removed; AppShell now gates on bootstrap state directly.
  assert.match(appShell, /isLoading/, 'AppShell should still render a pre-bootstrap loading state');
  assert.match(api, /network_unreachable/);
  assert.match(api, /127\.0\.0\.1/);
});

test('dashboard onboarding emits the Codex MCP config shape Codex actually reads', () => {
  // The snippet moved out of onboarding.tsx into the shared connectCopy module,
  // so every surface that shows a Codex config emits the same TOML.
  const connectCopy = read('src', 'lib', 'connectCopy.ts');
  const onboarding = read('src', 'pages', 'onboarding.tsx');

  assert.match(connectCopy, /\[mcp_servers\.deerdawn\]/);
  assert.match(connectCopy, /\[mcp_servers\.deerdawn\.env\]/);
  assert.match(connectCopy, /DEERDAWN_API_URL = "https:\/\/api\.deerdawn\.com"/);
  // Codex reads [mcp_servers.*], not [[mcpServers]] — and the key never ships
  // in a config snippet (the one-time user-code flow replaced it).
  assert.doesNotMatch(connectCopy, /DEERDAWN_API_KEY/);
  assert.doesNotMatch(connectCopy, /\[\[mcpServers\]\]/);
  assert.doesNotMatch(connectCopy, /\[mcpServers\.env\]/);
  assert.doesNotMatch(onboarding, /DEERDAWN_API_KEY/);
});

test('MCP auth flow uses a one-time user code instead of embedding an API key', () => {
  const mcpAuth = read('src', 'pages', 'mcp-auth.tsx');
  const mcpAuthorize = read('src', 'pages', 'api', 'mcp-authorize.ts');
  const api = read('src', 'lib', 'api.ts');

  assert.doesNotMatch(api, /startDesktopAuth/);
  assert.match(mcpAuth, /user_code: userCode/);
  assert.match(mcpAuthorize, /user_code/);
  assert.doesNotMatch(mcpAuth, /api_key/);
  assert.doesNotMatch(mcpAuth, /createKey\(/);
});

test('dashboard setup fallback routes require authenticated access and do not inspect local setup anonymously', () => {
  const setupStatusRoute = read('src', 'pages', 'api', 'setup-status.ts');
  const setupApplyRoute = read('src', 'pages', 'api', 'setup-apply.ts');

  assert.match(setupStatusRoute, /requireDashboardApiAuth/);
  assert.match(setupApplyRoute, /requireDashboardApiAuth/);
  assert.doesNotMatch(setupStatusRoute, /inspectLocalSetupStatus\('dashboard_fallback'\)/);
  assert.doesNotMatch(setupApplyRoute, /applySurfaceSetup\(surface, mode, 'dashboard_fallback'\)/);
});

test('billing pages validate external redirect targets before navigation', () => {
  const redirects = read('src', 'lib', 'redirects.ts');
  const selectPlan = read('src', 'pages', 'select-plan.tsx');
  const checkout = read('src', 'pages', 'checkout.tsx');
  const settingsPlan = read('src', 'pages', 'settings', 'plan.tsx');

  assert.match(redirects, /ALLOWED_REDIRECT_DOMAINS = \['stripe\.com', 'deerdawn\.com'\]/);
  assert.match(redirects, /parsed\.protocol !== 'https:'/);
  assert.match(redirects, /window\.location\.assign\(url\)/);
  // The checkout response no longer always carries a url — an in-place plan
  // change returns none — so these read `result.url`. What the contract is
  // about is that navigation goes through the validator, not the spelling of
  // the variable.
  assert.match(selectPlan, /redirectToTrustedUrl\(result\.url\)/);
  assert.match(checkout, /redirectToTrustedUrl\(result\.url\)/);
  assert.match(settingsPlan, /redirectToTrustedUrl\(result\.url\)/);
});

/**
 * 2026-09-17: this contract used to assert
 * `SELF_SERVE_PLANS = new Set(['developer_basic'])` in checkout.tsx and
 * settings/plan.tsx, plus `doesNotMatch(checkoutPage, /developer_pro/)`.
 *
 * Those lines were written when Pro was the only plan with a Stripe price, and
 * they went on asserting it after Team became purchasable on 2026-09-02 — so
 * the suite stayed green over a dashboard that rendered "contact sales" for the
 * plan marketing was selling as a cart, and would have gone RED on the fix. A
 * green assertion sitting on top of a live defect is worse than no assertion.
 *
 * What survives is the rule that was actually meant: Max (a retired tier) is
 * not sold, and no page keeps a PRIVATE copy of the self-serve set. WHICH plans
 * are in that set is pinned to plans.js by planCopy.test.ts — the only place
 * that can stay true the next time the set changes.
 */
test('personal billing pages sell one self-serve set from one place, and keep Max out of it', () => {
  // /select-plan and /settings/upgrade print their plan cards through a
  // component each (2026-09-28, so a test can render their prices), so each
  // surface is read as the page plus that component.
  const selectPlan = read('src', 'pages', 'select-plan.tsx') + read('src', 'components', 'billing', 'SelectPlanChoices.tsx');
  const checkoutPage = read('src', 'pages', 'checkout.tsx');
  const settingsPlan = read('src', 'pages', 'settings', 'plan.tsx');
  const upgradePage = read('src', 'pages', 'settings', 'upgrade.tsx') + read('src', 'components', 'billing', 'UpgradePlanCards.tsx');

  assert.doesNotMatch(selectPlan, /name:\s*'Max'/);
  assert.doesNotMatch(selectPlan, /Start Max/);
  // Copy rewritten; the contract is that Free is the no-card entry point.
  assert.match(selectPlan, /Start with Free/, 'select-plan should position Free as the entry point');
  assert.match(selectPlan, /No card required/i, 'select-plan should keep the no-card promise on Free');
  // Reworded to "The daily-driver tier for developers who build every day."
  // The contract is the positioning, not the sentence.
  assert.match(selectPlan, /daily-driver tier/, 'Pro should be positioned as the daily-driver tier');
  assert.match(selectPlan, /id: 'developer_basic'/, 'Pro (developer_basic) should be a self-serve option');

  assert.doesNotMatch(settingsPlan, /Upgrade to Max/);
  assert.doesNotMatch(settingsPlan, /return 'Max'/);
  // The set is imported, never rebuilt. An inline `new Set([...plan ids])` is
  // the exact shape that let this page and /checkout disagree with the API.
  assert.doesNotMatch(settingsPlan, /new Set\(\s*\[[^\]]*developer_/,
    'settings/plan must import the self-serve set, not keep its own copy');
  // The plan's NAME comes from lib/planCopy (itself pinned to plans.js
  // publicName by planCopy.test.ts), so this asserts the label is BUILT from
  // that constant rather than pinning a brand string. Pinning the literal is
  // what made this fail when "Founding Pro" became "Pro" in one place only.
  assert.match(settingsPlan, /PLAN_DISPLAY_NAME\[target\] \|\| target/, 'plan page should label upgrade targets from the shared names');
  assert.match(settingsPlan, /from '@\/lib\/planCopy'/, 'plan copy must come from the single source');

  // The metered starter/growth/scale tiers are still not sold (see the note on
  // the usage-reporting job in plans.js) — but that is plans.js's statement to
  // make, not a literal retyped here. What /checkout owes is that it consults
  // the shared predicate at all.
  assert.doesNotMatch(checkoutPage, /new Set\(\s*\[[^\]]*developer_/,
    'checkout must import the self-serve set, not keep its own copy');
  assert.match(checkoutPage, /isSelfServePlan\(plan\)/, 'checkout must gate on the shared predicate');

  assert.doesNotMatch(upgradePage, /name:\s*'Max'/);
  assert.doesNotMatch(upgradePage, /Full power for serious builders/);
  // Caption dropped with the declutter; assert the tier lineup instead.
  // Same reasoning as settings/plan.tsx above: the name is centralised, so the
  // contract is that the page names the Pro tier from the shared constant.
  assert.match(upgradePage, /name: PRO_PLAN_NAME/, 'upgrade page should still offer the Pro tier');
  assert.match(upgradePage, /from '@\/lib\/planCopy'/, 'plan copy must come from the single source');
});
