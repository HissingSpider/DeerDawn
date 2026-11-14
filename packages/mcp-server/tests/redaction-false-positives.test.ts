/**
 * Round 14: the client redactor must not rewrite ordinary text.
 *
 * redactSecrets runs on every update_context summary, flushed transcript and
 * captured command BEFORE it leaves the machine, so a false positive here is
 * the user's own words arriving at the API already mangled. `sk-` with no left
 * boundary took "task-scheduler-service-worker" to "ta[REDACTED]", and the
 * bare-whitespace AUTH_HEADER separator took "authorization middleware".
 *
 * The same corpus runs against the API's redactors in
 * apps/api/tests/unit/secret-redaction-corpus.test.js; keep them together.
 * Every fixture secret is fake and assembled by concatenation.
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

const FALSE_POSITIVES = [
  'Fix authorization middleware ordering',
  'Review authorization handling in the export route',
  'authorization: required.',
  'Authorization: Bearer authentication is required',
  'apikey mismatch between staging and prod',
  'the auth: middleware runs first',
  'token: short-lived',
  'task-queue-retry-worker',
  'task-runner-queue-worker',
  'task-scheduler-service-worker',
  'Refactor the task-scheduler-service-worker',
  'risk-assessment-for-q3-planning-2026',
  'Ship the risk-assessment-framework-v2',
  'disk-usage-monitor-agent-v2',
  'desk-booking-calendar-2026-component',
  'mask-sensitive-fields-in-logs-2026',
  'Migrate to flask-sqlalchemy-async-sessions by Q4',
  'sk-learn-pipeline-refactor-notes',
  'task_test_harnesses',
  'desk_live_dashboard',
  'Partition key: tenant_id',
  'primary key = (org_id, project_id)',
  'cache_key: user:123',
  'hotkey=ctrl+shift+k',
  'sort key: created_at',
  'key: src/auth/session.js',
  'apps/web/src/features/task-board/task-card-drag-handle.tsx',
  'commit 3f2a9c1e4b7d8a0f1e2d3c4b5a69788766554433',
  'uuid 550e8400-e29b-41d4-a716-446655440000',
  'dd_trace_id=5242894620198711562 dd.span_id=8349216579201834465',
  'dd_trace_id_propagation is on; dd_service_mapping_rules',
  'blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=',
  // Round 15: the upper-snake *_KEY env form is back; these must stay untouched.
  'SORT_KEY=created_at',
  'PRIMARY_KEY = (org_id, user_id)',
  'FOREIGN_KEY: users.id',
  'MAX_TOKENS=4096',
  'Set the x-api-key header on every request',
  'x-api-key header rotation',
  'glpat-rotation-runbook-notes-v2',
  'pypi-publishing-notes',
  // Round 16: round 15's *_KEY pass masked any value holding a digit, '+' or '='
  // — in the Stop hook, before anything left this machine. PARITY: the rows in
  // apps/api/tests/unit/secret-redaction-corpus.test.js.
  "const SEEN_KEY = 'dd_post_sync_modal_seen_v1';",
  "const ATTRIBUTION_KEY = 'dd_attribution_v1';",
  'ROUTING_KEY=orders.created.v1',
  'S3_OBJECT_KEY=exports/2026-09-23.csv',
  'S3_OBJECT_KEY=uploads/2024/avatar.png',
  'CACHE_KEY=user:123',
  'IDEMPOTENCY_KEY: order-2026-09-23-001',
  'IDEMPOTENCY_KEY=order-2024-0001',
  'I18N_KEY=onboarding.welcomeBackMessage2',
  'idempotencyKey: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"',
  'NEXT_PUBLIC_POSTHOG_KEY=phc_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK',
  // A runbook name is not a webhook secret; a reference is not a value.
  'whsec_rotation_plan',
  'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}',
  'DEERDAWN_API_KEY="${DEERDAWN_API_KEY:-dev-key}"',
  'export OPENAI_API_KEY=$OPENAI_API_KEY',
  'hf_transformers_pipeline_config',
  'lin_api_client_wrapper',
];

const TRUE_POSITIVES: Array<[string, string]> = [
  ['OpenAI legacy', 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4'],
  ['OpenAI project', 'sk-proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90'],
  ['OpenAI project inside a kebab run', 'rotate-' + 'sk-proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl12'],
  ['Anthropic', 'sk-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['Stripe secret', 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
  ['AWS access key id', 'AK' + 'IA' + 'IOSFODNN7EXAMPLE'],
  ['GitHub PAT', 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ['Slack', 'xo' + 'xb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOp'],
  ['DeerDawn API key', 'dd_' + '0a1b2c3d' + '_' + '4e5f'.repeat(16)],
  ['DeerDawn refresh token', 'ddr_' + '9c8b'.repeat(16)],
];

describe('client redactor: ordinary text', () => {
  it('comes back byte-identical', () => {
    const changed = FALSE_POSITIVES.filter((t) => redactSecrets(t) !== t).map((t) => `${t} -> ${redactSecrets(t)}`);
    expect(changed).toEqual([]);
  });
});

describe('client redactor: real-shaped secrets', () => {
  for (const [name, secret] of TRUE_POSITIVES) {
    it(`masks ${name}`, () => {
      const out = redactSecrets(`here: ${secret} end`);
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain(secret.slice(-16));
    });
  }

  it('still masks a key-named value and an authorization header', () => {
    expect(redactSecrets('OPENAI_API_KEY=' + 'abc123xyz789')).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(redactSecrets('Authorization Bearer ' + 'abcDEF12345678')).toBe('Authorization Bearer [REDACTED]');
    expect(redactSecrets('x-api-key: ' + 'abcdef12345678')).toBe('x-api-key: [REDACTED]');
  });
});

// Round 15: round 14 narrowed the KEY name to a whitelist (API_KEY, SECRET_KEY,
// ...) and every other upper-snake *_KEY env secret left this machine whole.
// PARITY: apps/api/tests/unit/secret-redaction-corpus.test.js holds the same rows.
const CONTEXTUAL: Array<[string, string, string]> = [
  ['Laravel APP_KEY', 'APP_KEY=' + 'base64:' + 'YUIzZEU1Z0g3aks5bU4xcFEyclM0dFU2dlc4eFkweg==', 'YUIzZEU1Z0g3aks5'],
  ['ALGOLIA_ADMIN_KEY', 'ALGOLIA_ADMIN_KEY=' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['MAILGUN_KEY', 'MAILGUN_KEY=' + 'key-' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['JWT_KEY', 'JWT_KEY=' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z', 'aB3dE5gH7jK9mN1p'],
  ['JWT_KEY, JSON', '{"JWT_KEY": "' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z' + '"}', 'aB3dE5gH7jK9mN1p'],
  ['HMAC_KEY, yaml', 'HMAC_KEY: ' + '9f86d081884c7d659a2feaa0c55ad015', '9f86d081884c7d65'],
  ['SENDGRID_KEY', 'SENDGRID_KEY=' + 'SG.' + 'aB3dE5gH7jK9mN1pQ2rS4t' + '.' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z', 'aB3dE5gH7jK9mN1pQ2rS4t'],
  ['Rails SECRET_KEY_BASE', 'SECRET_KEY_BASE=' + '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822c', '9f86d081884c7d65'],
  ['x-api-key header, no colon', 'curl -H "x-api-key ' + 'aB3dE5gH7jK9mN1pQ2rS4tU6"', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['JSON bearer header', '{"Authorization": "Bearer ' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"}', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['Slack incoming webhook', 'https://hooks.slack.com/services/' + 'T0ABC12345/B0DEF67890/' + 'aB3dE5gH7jK9mN1pQ2rS4tU6', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['GitLab PAT', 'token glpat-' + 'aB3dE5gH7jK9mN1pQ2rS', 'aB3dE5gH7jK9mN1pQ2rS'],
  ['PyPI token', 'pypi-' + 'AgEIcHlwaS5vcmc' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK9', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  // Round 16: provider formats, a password holding '@', and key names that are
  // not upper-snake (round 13 masked these; round 14 let them through).
  ['Fly.io token', 'FLY_API_TOKEN=Fly' + 'V1 fm2_' + 'lJPECAAAAAAAAMyUxBDaB3dE5gH7jK9mN1pQ2rS4tU6', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['Hugging Face', 'HF_TOKEN=hf_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['Shopify', 'token shp' + 'at_' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['Linear', 'lin_' + 'api_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['Doppler', 'dp.' + 'st.prod.' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK9', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['URI password holding @', 'postgres://app:p@' + 'ssw0rd@db.internal:5432/app', 'ssw0rd'],
  ['Azure storage connection string', 'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=' + 'q83vEjRWeJCrze8SNFZ4mg7R1bXkP0yT+/Lw9cZfUhA3sG2iN6dVoQ5aYxK4eB8jMnHuWt1z0rC7pFg9lIsE2vDy+Kh==' + ';EndpointSuffix=core.windows.net', 'q83vEjRWeJCrze8S'],
  ['Azure APIM subscription key', 'Ocp-Apim-Subscription-Key: ' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d', '3a1f8c6e4b2d0a9f'],
  ['camelCase key, JSON', '{"storageKey":"' + 'q83vEjRWeJCrze8SNFZ4mg7R1bXkP0yT+/Lw9cZfUhA3sG2iN6dVoQ5aYxK4eB8jMnHuWt1z0rC7pFg9lIsE2vDy+Kh==' + '"}', 'q83vEjRWeJCrze8S'],
  ['camelCase key, single quotes', "algoliaAdminKey: '" + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d' + "'", '3a1f8c6e4b2d0a9f'],
  ['snake key, spaced', 'license_key = "' + '9f86d081884c7d659a2feaa0c55ad015' + '"', '9f86d081884c7d65'],
  ['snake key, bare', 'admin_key=' + '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b', '9f86d081884c7d65'],
];

describe('client redactor: upper-snake *_KEY env secrets and header forms (round 15)', () => {
  for (const [name, text, secret] of CONTEXTUAL) {
    it(`masks ${name}`, () => {
      const out = redactSecrets(text);
      expect(out).not.toContain(secret);
      expect(redactSecrets(out)).toBe(out);
    });
  }

  it('keeps the name and the JSON shape', () => {
    expect(redactSecrets('APP_KEY=' + 'base64:YUIzZEU1Z0g3aks5bU4x')).toBe('APP_KEY=[REDACTED]');
    expect(redactSecrets('AccountName=acme;AccountKey=' + 'q83vEjRWeJCrze8SNFZ4mg7R1bXkP0yT+/Lw9cZfUhA3sG2iN6dVoQ5aYxK4eB8jMnHuWt1z0rC7pFg9lIsE2vDy+Kh==' + ';EndpointSuffix=core.windows.net'))
      .toBe('AccountName=acme;AccountKey=[REDACTED];EndpointSuffix=core.windows.net');
    expect(redactSecrets('postgres://app:p@ss@db:5432/app')).toBe('postgres://app:[REDACTED]@db:5432/app');
    expect(redactSecrets('{"Authorization": "Bearer ' + 'aB3dE5gH7jK9mN1pQ2rS"}')).toBe('{"Authorization": "Bearer [REDACTED]"}');
  });
});
