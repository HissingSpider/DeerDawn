/**
 * The secret redactors, table-driven, in both directions.
 *
 * Round 13 made the store run redactSecrets over EVERY string it persists
 * (store.redactForStorage) and over graph canonical keys. From then on a false
 * positive was not a cosmetic glitch in one rendered brief: it rewrote the
 * stored text irreversibly, and broke every comparison between the caller's
 * words and the stored ones (a card looked up by its title, "is this the same
 * task?", a graph node's identity). Round 14 found `sk-` matching inside
 * "task-", "risk-", "flask-" and AUTH_HEADER taking "authorization middleware".
 *
 * So every surface that masks text is held to one false-positive corpus (must
 * come back byte-identical) and one true-positive corpus (the secret must be
 * gone): the API redactor, the store's persist pass, the hosted MCP output
 * mask, and the shared-context normalizer copy. The mcp-server client redactor
 * holds the same corpus in packages/mcp-server/tests/redaction-false-positives.test.ts.
 *
 * Every fixture secret is fake and assembled by concatenation.
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactDeep, secretSafeKey, REDACTED } = require('../../src/utils/secretRedaction');
const { redactForStorage } = require('../../src/store/contextSyncStore');
const mcpSafety = require('../../src/services/mcpSafety');
const { redactSecretText } = require('../../../../packages/shared-context/src/index.js');

test.after(async () => {
  await require('../../src/config/db').pool.end().catch(() => {});
});

const FALSE_POSITIVES = [
  // prose that names auth things
  'Fix authorization middleware ordering',
  'Review authorization handling in the export route',
  'authorization: required.',
  'The Authorization: Basic scheme is documented in RFC 7617.',
  'Authorization: Bearer authentication is required',
  'authorization: bearer tokens are required',
  'apikey mismatch between staging and prod',
  'the auth: middleware runs first',
  'ADMIN_PASSWORD: contact support',
  'token: short-lived',
  'Bearer tokens are required for every route',
  // kebab words ending in -sk / -sk- + 16 chars
  'task-queue-retry-worker',
  'service:task-queue-retry-worker',
  'task-runner-queue-worker',
  'task-scheduler-service-worker',
  'Refactor the task-scheduler-service-worker',
  'Split the task-scheduler-service-worker',
  'risk-assessment-for-q3-planning-2026',
  'risk-assessment-framework-v2',
  'Ship the risk-assessment-framework-v2',
  'disk-usage-monitor-agent-v2',
  'desk-booking-calendar-2026-component',
  'ask-the-user-before-deleting-anything-v3',
  'mask-sensitive-fields-in-logs-2026',
  'Migrate to flask-sqlalchemy-async-sessions by Q4',
  'Migrate to flask-sqlalchemy-integration by Q4',
  'sk-learn-pipeline-refactor-notes',
  'task_test_harnesses',
  'desk_live_dashboard',
  'xoxb-integration-settings-page',
  // DB / design text around the word "key"
  'Partition key: tenant_id',
  'Partition key: tenant_id on the events table; primary key = (org_id, user_id)',
  'primary key = (org_id, project_id)',
  'cache_key: user:123',
  'hotkey=ctrl+shift+k',
  'sort key: created_at',
  'key: src/auth/session.js',
  // Round 15: the upper-snake env form is back, and must stay off everything
  // that is not an env secret — an unsuffixed or lowercase name, a value with
  // no digit/'+'/'=', a plural (MAX_TOKENS), prose about the x-api-key header,
  // a lowercase kebab id behind a token prefix.
  'SORT_KEY=created_at',
  'PRIMARY_KEY = (org_id, user_id)',
  'FOREIGN_KEY: users.id',
  'MAX_TOKENS=4096',
  'Set the x-api-key header on every request',
  'x-api-key header rotation',
  'x-api-key v2 rollout',
  'glpat-rotation-runbook-notes-v2',
  'pypi-publishing-notes',
  'hooks.slack.com/services is the webhook host',
  // paths, ids, hashes, encodings
  'apps/web/src/features/task-board/task-card-drag-handle.tsx',
  'src/components/desk-booking-calendar.tsx',
  'services/risk-assessment-engine/index.ts',
  'commit 3f2a9c1e4b7d8a0f1e2d3c4b5a69788766554433',
  'uuid 550e8400-e29b-41d4-a716-446655440000',
  'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'dd_trace_id=5242894620198711562 dd.span_id=8349216579201834465',
  'dd_trace_id propagates; odd_0123abcd_ fields',
  'dd_trace_id_propagation is on; dd_service_mapping_rules',
  'dd_0a1b2c3d is the key prefix shown in the dashboard',
  'blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=',
  'http://localhost:8080/path@v2',
  'git@github.com:HissingSpider/DeerDawn.git',
  'just a normal log line about project foo',
  '[REDACTED]',
  // Round 16: round 15's *_KEY pass took ANY upper-snake *_KEY whose value held
  // a digit, '+' or '=' — these, most of them verbatim from DeerDawn's own
  // source, were masked at storage and two board cards differing only in one
  // merged. A *key name is now masked only over a SECRET-SHAPED value.
  'const SEEN_KEY = \'dd_post_sync_modal_seen_v1\';',
  'const ATTRIBUTION_KEY = \'dd_attribution_v1\';',
  'ROUTING_KEY=orders.created.v1',
  'S3_OBJECT_KEY=exports/2026-09-23.csv',
  'S3_OBJECT_KEY=uploads/2024/avatar.png',
  'CACHE_KEY=user:123',
  'CACHE_KEY=user:123:profile',
  'IDEMPOTENCY_KEY: order-2026-09-23-001',
  'IDEMPOTENCY_KEY=order-2024-0001',
  'LOCK_KEY=cron:daily-report:2026',
  'I18N_KEY=home.hero.title_v2',
  'I18N_KEY=onboarding.welcomeBackMessage2',
  'GROUPING_KEY=build-42',
  'REDIS_KEY=session:{id}:v2',
  'DEDUPE_KEY=event_id+ts',
  'storageKey: "exports/2026/09/report-v2.csv"',
  'idempotencyKey: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"',
  // A name that says the value is published is not a secret name.
  'NEXT_PUBLIC_POSTHOG_KEY=phc_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK',
  // References to a secret are not one.
  'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}',
  'DATABASE_PASSWORD=${DB_PASSWORD_2}',
  'export OPENAI_API_KEY=$OPENAI_API_KEY',
  // Identifiers behind the round-16 provider prefixes.
  'whsec_rotation_plan',
  'hf_transformers_pipeline_config',
  'shpat_rotation_runbook',
  'lin_api_client_wrapper',
  'dp.st.notes for the doppler migration',
  'fm2_migration_plan',
  'https://example.com/cb?sig=short&page=2',
  'postgres://localhost:5432/deerdawn',
];

const TRUE_POSITIVES = [
  ['OpenAI legacy', 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4'],
  ['OpenAI project', 'sk-proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90'],
  ['OpenAI project, lowercase fixture', 'sk-proj-' + 'abcdefghijklmnop1234'],
  ['Anthropic', 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['Anthropic glued to prior text', 'xxxx' + 'sk-ant-api03-' + 'A'.repeat(40)],
  ['Stripe secret', 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
  ['Stripe restricted', 'rk_' + 'test_' + '51Hx9aBcDeFgHiJkL0mN'],
  ['AWS access key id', 'AK' + 'IA' + 'IOSFODNN7EXAMPLE'],
  ['GitHub PAT', 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ['GitHub fine-grained PAT', 'github_' + 'pat_' + '11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
  ['Slack', 'xo' + 'xb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOp'],
  ['Google API key', 'AI' + 'za' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['JWT', 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['DeerDawn API key', 'dd_' + '0a1b2c3d' + '_' + '4e5f'.repeat(16)],
  ['DeerDawn refresh token', 'ddr_' + '9c8b'.repeat(16)],
  ['PEM block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2c3\n-----END RSA PRIVATE KEY-----'],
  // Round 16: formats every redactor still let through.
  ['Fly.io token', 'Fly' + 'V1 fm2_' + 'lJPECAAAAAAAAMyUxBDaB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'],
  ['Fly.io bare macaroon', 'fm2_' + 'lJPECAAAAAAAAMyUxBDaB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['Hugging Face', 'hf_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3'],
  ['Shopify admin token', 'shp' + 'at_' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d'],
  ['Linear API key', 'lin_' + 'api_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7'],
  ['Doppler service token', 'dp.' + 'st.prod.' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK9'],
  ['JWT behind a URL-encoded =', 'id_token%3D' + 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['Azure SAS signature', 'https://acme.blob.core.windows.net/c?sv=2022-11-02&ss=b&sig=' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z%2BaB3dE5gH%3D'],
];

// Secrets that the pattern families catch only in their CONTEXT (a header, a
// key=value, a URI) rather than by shape.
const CONTEXTUAL_TRUE_POSITIVES = [
  ['bearer header', 'curl -H "Authorization: Bearer ' + 'abcdefgh12345678ABCDEF"', 'abcdefgh12345678ABCDEF'],
  ['bearer header, no colon', 'Authorization Bearer ' + 'abcDEF12345678', 'abcDEF12345678'],
  ['basic header', 'Authorization: Basic ' + 'ZGVwbG95Omh1bnRlcnR3bw==', 'ZGVwbG95Omh1bnRlcnR3bw=='],
  ['json api_key', '{"api_key": "' + 'abc123def456ghi' + '"}', 'abc123def456ghi'],
  ['x-api-key header', 'x-api-key: ' + 'abcdef12345678', 'abcdef12345678'],
  ['env API key', 'OPENAI_API_KEY=' + 'abc123xyz789', 'abc123xyz789'],
  ['AWS secret access key', 'AWS_SECRET_ACCESS_KEY=' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['PGPASSWORD', 'PGPASSWORD=' + 'hunter2supersecret psql', 'hunter2supersecret'],
  ['password: value', 'password: ' + 'hunter2hunter', 'hunter2hunter'],
  ['URI credentials', 'psql postgres://user:' + 's3cr3tpassword@db.example.com/app', 's3cr3tpassword'],
  // Round 15: round 14 narrowed KEY to a whitelist and every other upper-snake
  // *_KEY env secret was stored and served verbatim.
  ['Laravel APP_KEY', 'APP_KEY=' + 'base64:' + 'YUIzZEU1Z0g3aks5bU4xcFEyclM0dFU2dlc4eFkweg==', 'YUIzZEU1Z0g3aks5'],
  ['ALGOLIA_ADMIN_KEY', 'ALGOLIA_ADMIN_KEY=' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['MAILGUN_KEY', 'MAILGUN_KEY=' + 'key-' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['JWT_KEY', 'JWT_KEY=' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z', 'aB3dE5gH7jK9mN1p'],
  ['JWT_KEY, JSON', '{"JWT_KEY": "' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z' + '"}', 'aB3dE5gH7jK9mN1p'],
  ['HMAC_KEY, yaml', 'HMAC_KEY: ' + '9f86d081884c7d659a2feaa0c55ad015', '9f86d081884c7d65'],
  ['SENDGRID_KEY', 'SENDGRID_KEY=' + 'SG.' + 'aB3dE5gH7jK9mN1pQ2rS4t' + '.' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z', 'aB3dE5gH7jK9mN1pQ2rS4t'],
  ['Rails SECRET_KEY_BASE', 'SECRET_KEY_BASE=' + '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822c', '9f86d081884c7d65'],
  ['DB_PASS', 'DB_PASS=' + 'hunter2hunter2', 'hunter2hunter2'],
  ['x-api-key header, no colon', 'curl -H "x-api-key ' + 'aB3dE5gH7jK9mN1pQ2rS4tU6"', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['redis URI with no user', 'REDIS_URL=redis://:' + 'p4ssw0rdXyz@redis:6379/0', 'p4ssw0rdXyz'],
  ['Slack incoming webhook', 'https://hooks.slack.com/services/' + 'T0ABC12345/B0DEF67890/' + 'aB3dE5gH7jK9mN1pQ2rS4tU6', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['GitLab PAT', 'token glpat-' + 'aB3dE5gH7jK9mN1pQ2rS', 'aB3dE5gH7jK9mN1pQ2rS'],
  ['PyPI token', 'pypi-' + 'AgEIcHlwaS5vcmc' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK9', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['npm token', 'npm_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8x', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['webhook secret', 'whsec_' + 'aB3dE5gH7jK9mN1pQ2rS4t', 'aB3dE5gH7jK9mN1pQ2rS4t'],
  // Round 16: env-var and key-name forms.
  ['Fly.io token, env', 'FLY_API_TOKEN=Fly' + 'V1 fm2_' + 'lJPECAAAAAAAAMyUxBDaB3dE5gH7jK9mN1pQ2rS4tU6', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['URI password holding @', 'DATABASE_URL=postgres://app:p@' + 'ssw0rd@db.internal:5432/app', 'ssw0rd'],
  // Round 13 masked every *key name; round 14 narrowed that to a whitelist and
  // these went out whole. A key name over a secret-shaped value is masked again.
  ['Azure storage connection string', 'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=' + 'q83vEjRWeJCrze8SNFZ4mg7R1bXkP0yT+/Lw9cZfUhA3sG2iN6dVoQ5aYxK4eB8jMnHuWt1z0rC7pFg9lIsE2vDy+Kh==' + ';EndpointSuffix=core.windows.net', 'q83vEjRWeJCrze8S'],
  ['Azure APIM subscription key', 'Ocp-Apim-Subscription-Key: ' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['camelCase key, JSON', '{"storageKey":"' + 'q83vEjRWeJCrze8SNFZ4mg7R1bXkP0yT+/Lw9cZfUhA3sG2iN6dVoQ5aYxK4eB8jMnHuWt1z0rC7pFg9lIsE2vDy+Kh==' + '"}', 'q83vEjRWeJCrze8S'],
  ['camelCase key, single quotes', 'algoliaAdminKey: \'' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d' + '\'', '3a1f8c6e4b2d0a9f'],
  ['snake key, spaced', 'license_key = "' + '9f86d081884c7d659a2feaa0c55ad015' + '"', '9f86d081884c7d65'],
  ['snake key, bare', 'admin_key=' + '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b', '9f86d081884c7d65'],
  ['lowercase dotenv base64 key', 'app_key=base64:' + 'YUIzZEU1Z0g3aks5bU4xcFEyclM0dFU2dlc4eFkweg==', 'YUIzZEU1Z0g3aks5'],
];

// The hosted MCP output mask is deliberately narrower (it runs on every reply
// and is not the persist floor): bearer values, DeerDawn's own keys, Stripe.
const MCP_TRUE_POSITIVES = [
  ['DeerDawn API key', 'dd_' + '0a1b2c3d' + '_' + '4e5f'.repeat(16)],
  ['DeerDawn refresh token', 'ddr_' + '9c8b'.repeat(16)],
  ['Stripe secret', 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
  ['bearer value', 'Bearer ' + 'abc.def.ghi'],
];

const SURFACES = [
  ['redactSecrets', (s) => redactSecrets(s)],
  ['redactDeep', (s) => redactDeep({ v: s }).v],
  ['store.redactForStorage (persist + REST output mask)', (s) => redactForStorage({ context: { v: [s] } }).context.v[0]],
  ['shared-context redactSecretText', (s) => redactSecretText(s)],
];
const MCP_SURFACES = [
  ['mcpSafety.redactDeep (export_trail)', (s) => mcpSafety.redactDeep({ note: s }).note],
  ['mcpSafety.sanitizeToolResult (every hosted reply)', (s) => mcpSafety.sanitizeToolResult({ content: [{ type: 'text', text: s }] }).content[0].text],
];

for (const [surface, run] of [...SURFACES, ...MCP_SURFACES]) {
  test(`${surface}: ordinary text comes back byte-identical`, () => {
    const changed = FALSE_POSITIVES.filter((text) => run(text) !== text).map((text) => `${text} -> ${run(text)}`);
    assert.deepEqual(changed, []);
  });
}

for (const [surface, run] of SURFACES) {
  test(`${surface}: every real-shaped secret is masked`, () => {
    for (const [name, secret] of TRUE_POSITIVES) {
      const out = run(`here it is: ${secret} (do not share)`);
      assert.ok(out.includes(REDACTED), `${name}: nothing masked in ${out}`);
      assert.ok(!out.includes(secret.slice(-16)), `${name}: secret survived: ${out}`);
    }
    for (const [name, text, secret] of CONTEXTUAL_TRUE_POSITIVES) {
      const out = run(text);
      assert.ok(!out.includes(secret), `${name}: secret survived: ${out}`);
    }
  });

  test(`${surface}: idempotent — a second pass changes nothing`, () => {
    for (const text of [...FALSE_POSITIVES, ...TRUE_POSITIVES.map(([, s]) => `x ${s} y`), ...CONTEXTUAL_TRUE_POSITIVES.map(([, t]) => t)]) {
      const once = run(text);
      assert.equal(run(once), once, `not idempotent on: ${text}`);
    }
  });
}

for (const [surface, run] of MCP_SURFACES) {
  test(`${surface}: DeerDawn / Stripe / bearer credentials are masked`, () => {
    for (const [name, secret] of MCP_TRUE_POSITIVES) {
      const out = run(`value ${secret} end`);
      assert.ok(out.includes('[REDACTED]') && !out.includes(secret.slice(-10)), `${name}: ${out}`);
    }
  });
}

test('secretSafeKey: an ordinary key is returned unchanged', () => {
  for (const key of ['service:task-queue-retry-worker', 'task:ship-the-risk-assessment-framework-v2', 'file:src/components/desk-booking-calendar.tsx', 'decision:partition-key:-tenant_id']) {
    assert.equal(secretSafeKey(key), key);
  }
});

test('secretSafeKey: a secret-bearing key becomes a stable, distinct, non-reversible stand-in', () => {
  const a = `service:rotate-sk-proj-${'A1b2C3d4'.repeat(4)}`;
  const b = `service:rotate-sk-proj-${'Z9y8X7w6'.repeat(4)}`;
  const ka = secretSafeKey(a);
  const kb = secretSafeKey(b);
  assert.match(ka, /^service:redacted-[0-9a-f]{32}$/);
  assert.notEqual(ka, kb, 'two different secrets must not share one key');
  assert.equal(secretSafeKey(a), ka, 'the same key must map to the same stand-in');
  assert.ok(!ka.includes('A1b2C3d4'));
  // The store applies it again to a key the service already made safe.
  assert.equal(secretSafeKey(ka), ka, 'the stand-in must itself be a safe key');
  // A secret visible only in the SOURCE (lower-cased away in the key) still counts.
  const lowered = 'service:rotate-akiaiosfodnn7example';
  assert.equal(secretSafeKey(lowered), lowered);
  assert.match(secretSafeKey(lowered, { source: 'Rotate ' + 'AK' + 'IAIOSFODNN7EXAMPLE' }), /^service:redacted-[0-9a-f]{32}$/);
});
