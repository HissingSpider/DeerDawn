const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('./helpers/privatePaths');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');

function readFromApi(relativePath) {
  return fs.readFileSync(path.join(apiRoot, relativePath), 'utf8');
}

function readFromRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function existsInRepo(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

// `requires`: repo paths the test reads that only the private repo has; the
// test is reported as skipped where they are missing (the public export).
function test(name, fn, { requires = [] } = {}) {
  const skip = privateSkipReason(...requires);
  if (skip) {
    console.log(`- ${name} (skipped: ${skip})`);
    return;
  }
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Full Confidence Contract Tests ===\n');

const dashboardRoute = readFromApi('src/routes/shared/dashboard.js');
const onboardingService = readFromApi('src/services/onboardingService.js');
const dashboardApi = readFromRepo('apps/dashboard/src/lib/api.ts');
const MARKETING = { requires: ['apps/marketing'] };
const readMarketing = (rel) => (privateSkipReason('apps/marketing') ? '' : readFromRepo(rel));
const marketingRobots = readMarketing('apps/marketing/src/pages/robots.txt.ts');
const marketingSitemap = readMarketing('apps/marketing/src/pages/sitemap.xml.tsx');
const smokeScript = readFromApi('scripts/smoke-e2e.sh');

test('dashboard bootstrap should expose machine-readable status fields', () => {
  assert(dashboardRoute.includes('status:'), 'dashboard bootstrap response is missing status');
  assert(dashboardRoute.includes('error_code:'), 'dashboard bootstrap response is missing error_code');
});

test('dashboard bootstrap should expose visible navigation contract', () => {
  assert(
    dashboardRoute.includes('visible_navigation'),
    'dashboard bootstrap response is missing visible_navigation'
  );
  assert(
    dashboardApi.includes('visible_navigation'),
    'dashboard bootstrap type is missing visible_navigation'
  );
});

test('dashboard bootstrap should query escalation_resolutions instead of obsolete escalations table', () => {
  assert(
    dashboardRoute.includes('FROM escalation_resolutions'),
    'dashboard bootstrap still references the obsolete escalations table'
  );
});

test('dashboard bootstrap type should include machine-readable status fields', () => {
  assert(dashboardApi.includes('status:'), 'dashboard bootstrap type is missing status');
  assert(dashboardApi.includes('error_code?: string | null;'), 'dashboard bootstrap type is missing error_code');
});

test('marketing robots should not block major LLM crawlers', () => {
  for (const blocked of ['GPTBot', 'ClaudeBot', 'Google-Extended']) {
    assert(
      !marketingRobots.includes(`User-agent: ${blocked}\nDisallow: /`),
      `robots.txt still blocks ${blocked}`
    );
  }
}, MARKETING);

test('marketing should publish llms discovery surfaces', () => {
  assert(existsInRepo('apps/marketing/src/pages/llms.txt.ts'), 'llms.txt route is missing');
  assert(existsInRepo('apps/marketing/src/pages/llms-full.txt.ts'), 'llms-full.txt route is missing');
  assert(existsInRepo('apps/marketing/src/pages/deerdawn-llm.txt.ts'), 'deerdawn-llm.txt route is missing');
}, MARKETING);

test('marketing sitemap should include key acquisition pages', () => {
  for (const route of ['/docs/quickstart', '/faq', '/use-cases/', '/compare/']) {
    assert(marketingSitemap.includes(route), `sitemap is missing ${route}`);
  }
}, MARKETING);

test('smoke verification should exercise dashboard bootstrap and onboarding flow', () => {
  assert(smokeScript.includes('/api/v1/dashboard/bootstrap'), 'smoke script does not verify dashboard bootstrap');
  assert(smokeScript.includes('/api/v1/onboarding/state'), 'smoke script does not verify onboarding state');
  assert(smokeScript.includes('/api/v1/policies/from-template'), 'smoke script does not verify policy template creation');
});

if (process.exitCode) {
  console.error('\nFull confidence regressions detected.');
} else {
  console.log('\nFull confidence contracts in place.');
}
