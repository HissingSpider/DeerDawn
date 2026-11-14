const test = require('node:test');
const assert = require('node:assert/strict');

const { SignupRequestSchema } = require('../../src/schemas');

const basePayload = {
  email: 'signup-test@example.com',
  password: 'password123',
};

test('SignupRequestSchema accepts organization CTA plans and legacy aliases', () => {
  for (const plan of ['starter', 'growth', 'developer_basic', 'developer_pro', 'personal_basic', 'personal_developer']) {
    const parsed = SignupRequestSchema.safeParse({ ...basePayload, plan });
    assert.equal(parsed.success, true, `expected plan ${plan} to be accepted`);
  }
});

test('SignupRequestSchema still rejects an empty plan string', () => {
  const parsed = SignupRequestSchema.safeParse({ ...basePayload, plan: '   ' });
  assert.equal(parsed.success, false);
});
