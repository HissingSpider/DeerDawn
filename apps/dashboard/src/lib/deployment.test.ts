/**
 * Self-hosted deployment helpers: what the dashboard concludes from the API's
 * deployment answer, the telemetry gate, and the invitation token a sign-up
 * carries. Run: `tsx --test src/lib/deployment.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SOURCE_CODE_URL, HOSTED_DEPLOYMENT, inviteTokenFromReturnPath, parseDeployment, safeSourceCodeUrl } from './deployment';
import { clientTelemetryAllowed, isSelfHostedBuild } from './telemetryGate';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const OFF = { DD_SELF_HOSTED: undefined, DD_TELEMETRY_ENABLED: undefined, SELF_HOSTED: undefined, TELEMETRY_ENABLED: undefined };

test('a hosted build with no answer from the API is hosted', () => {
  withEnv(OFF, () => {
    assert.deepStrictEqual(parseDeployment(null), HOSTED_DEPLOYMENT);
    assert.equal(isSelfHostedBuild(), false);
    assert.equal(clientTelemetryAllowed(), true);
  });
});

test('the API saying self_hosted turns billing off whatever else it says', () => {
  withEnv(OFF, () => {
    const d = parseDeployment({ self_hosted: true, billing_enabled: true, telemetry_enabled: false, signup_mode: 'invite_only', auth_provider: 'local' });
    assert.equal(d.self_hosted, true);
    assert.equal(d.billing_enabled, false);
    assert.equal(d.telemetry_enabled, false);
    assert.equal(d.signup_mode, 'invite_only');
  });
});

test('a self-hosted build is self-hosted even before (or without) the API answering', () => {
  withEnv({ ...OFF, DD_SELF_HOSTED: 'true' }, () => {
    const d = parseDeployment(null);
    assert.equal(d.self_hosted, true);
    assert.equal(d.billing_enabled, false);
    assert.equal(d.signup_mode, 'invite_only');
  });
});

test('telemetry is off on a self-hosted build unless TELEMETRY_ENABLED=true', () => {
  withEnv({ ...OFF, DD_SELF_HOSTED: 'true' }, () => assert.equal(clientTelemetryAllowed(), false));
  withEnv({ ...OFF, DD_SELF_HOSTED: 'true', DD_TELEMETRY_ENABLED: 'true' }, () => assert.equal(clientTelemetryAllowed(), true));
  // Server side (the _document render): the runtime variable is honoured too.
  withEnv({ ...OFF, SELF_HOSTED: 'true' }, () => assert.equal(clientTelemetryAllowed(), false));
});

test('the invitation token is read from the /invite return path only', () => {
  assert.equal(inviteTokenFromReturnPath('/invite?token=abc123'), 'abc123');
  assert.equal(inviteTokenFromReturnPath('/invite?token=a%2Bb'), 'a+b');
  assert.equal(inviteTokenFromReturnPath('/settings?token=abc123'), null);
  assert.equal(inviteTokenFromReturnPath('/invite'), null);
  assert.equal(inviteTokenFromReturnPath(undefined), null);
});

test('the Google Ads id has no built-in default (a self-host must never beacon to DeerDawn)', () => {
  const src = readFileSync(fileURLToPath(new URL('./gtag.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /GOOGLE_ADS_ID\s*=\s*process\.env\.NEXT_PUBLIC_GOOGLE_ADS_ID\s*\|\|\s*'AW-/);
});

test('the settings index draws no plan, billing or referral entry on a self-host', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/settings.tsx', import.meta.url)), 'utf8');
  assert.match(src, /const \{ (deployment, )?selfHosted \} = useDeployment\(\)/);
  assert.match(src, /\{!selfHosted && \(\s*<LinkRow\s+href="\/settings\/plan"/, 'the Plan & billing row must be hidden on a self-host');
  assert.match(src, /referralCode && !selfHosted/, 'the referral card must be hidden on a self-host');
});

test('the usage page draws no plan label, plan line or upgrade card on a self-host', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/settings/usage.tsx', import.meta.url)), 'utf8');
  assert.match(src, /const \{ selfHosted \} = useDeployment\(\)/);
  assert.match(src, /\{!selfHosted && <span[^>]*>\{planLabel\}<\/span>\}/);
  assert.match(src, /isFreeTier && !selfHosted \?/, 'the upgrade card must be hidden on a self-host');
});

test('every billing page is wrapped in the self-hosted gate', () => {
  for (const page of ['settings/plan.tsx', 'settings/upgrade.tsx', 'settings/refer.tsx', 'select-plan.tsx', 'checkout.tsx']) {
    const src = readFileSync(fileURLToPath(new URL(`../pages/${page}`, import.meta.url)), 'utf8');
    assert.match(src, /<SelfHostedBillingGate/, `${page} renders billing UI on a self-host`);
  }
});

test('source_code_url (AGPL-3.0 section 13): the API value when it is an http(s) URL, upstream otherwise', () => {
  withEnv(OFF, () => {
    assert.equal(HOSTED_DEPLOYMENT.source_code_url, DEFAULT_SOURCE_CODE_URL);
    assert.equal(DEFAULT_SOURCE_CODE_URL, 'https://github.com/HissingSpider/DeerDawn');
    assert.equal(parseDeployment(null).source_code_url, DEFAULT_SOURCE_CODE_URL);
    assert.equal(parseDeployment({ self_hosted: false }).source_code_url, DEFAULT_SOURCE_CODE_URL);
    assert.equal(
      parseDeployment({ self_hosted: true, source_code_url: 'https://git.example.com/acme/deerdawn-fork' }).source_code_url,
      'https://git.example.com/acme/deerdawn-fork',
    );
    for (const bad of ['javascript:alert(1)', 'not a url', '', 42, null]) {
      assert.equal(safeSourceCodeUrl(bad), DEFAULT_SOURCE_CODE_URL, String(bad));
    }
  });
  withEnv({ ...OFF, DD_SELF_HOSTED: 'true' }, () => {
    assert.equal(parseDeployment(null).source_code_url, DEFAULT_SOURCE_CODE_URL);
  });
});

test('Settings draws a "Source code" row linking to the deployment source_code_url', () => {
  const settings = readFileSync(fileURLToPath(new URL('../pages/settings.tsx', import.meta.url)), 'utf8');
  assert.match(settings, /deployment\?\.source_code_url \|\| DEFAULT_SOURCE_CODE_URL/);
  assert.match(settings, /href=\{sourceCodeUrl\}/);
  assert.match(settings, />Source code</);
  // Not behind the self-hosted switch: every user of a running install sees it.
  const row = settings.slice(settings.indexOf('data-testid="source-code-link"') - 400, settings.indexOf('>Source code<'));
  assert.doesNotMatch(row, /selfHosted|!selfHosted/);
});
