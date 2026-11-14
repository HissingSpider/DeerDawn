/**
 * Secret redaction (CSL-01 / LOG-07) — no DB.
 */
const test = require('node:test');
const assert = require('node:assert');
const { redactSecrets, redactDeep, REDACTED } = require('../../src/utils/secretRedaction');

test('redactSecrets masks provider keys, bearer tokens, assignments, and URI creds', () => {
    const cases = [
        ['export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234', 'sk-proj'],
        ['curl -H "Authorization: Bearer eyJhbGciOi.JzdWIiOi12.abcDEF1234"', 'eyJ'],
        ['PGPASSWORD=hunter2supersecret psql', 'hunter2'],
        ['psql postgres://user:s3cr3tpassword@db.example.com/app', 's3cr3tpassword'],
        ['token sk-ant-api03-abcdefghijklmnop', 'sk-ant'],
        ['aws AKIAIOSFODNN7EXAMPLE key', 'AKIAIOSFODNN7EXAMPLE'],
        ['gh ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_'],
        ['slack xoxb-123456789012-abcdefghijkl', 'xoxb-'],
    ];
    for (const [input, secretFragment] of cases) {
        const out = redactSecrets(input);
        assert.ok(out.includes(REDACTED), `expected redaction in: ${input} -> ${out}`);
        assert.ok(!out.includes(secretFragment), `secret fragment "${secretFragment}" survived: ${out}`);
    }
});

test('redactSecrets preserves non-secret text and is a no-op on non-strings', () => {
    assert.strictEqual(redactSecrets('just a normal log line about project foo'), 'just a normal log line about project foo');
    assert.strictEqual(redactSecrets(42), 42);
    assert.strictEqual(redactSecrets(null), null);
});

test('redactDeep walks objects and arrays', () => {
    const out = redactDeep({ cmd: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 run', nested: ['AKIAIOSFODNN7EXAMPLE'] });
    assert.ok(!JSON.stringify(out).includes('sk-proj-abcdefghijklmnop1234'));
    assert.ok(!JSON.stringify(out).includes('AKIAIOSFODNN7EXAMPLE'));
});
