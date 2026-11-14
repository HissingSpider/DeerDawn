const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const resendClient = require('../../src/services/email/resendClient');
const productEvents = require('../../src/services/productEventsService');
const svc = require('../../src/services/email/dormantReactivation');

// A-4 is bulk commercial email to ~28 people who never used the product. Three
// things must hold or it should not go out at all:
//   1. it never sends unless a human explicitly asks (dry run is the default),
//   2. it carries a working unsubscribe and a postal address,
//   3. it can never mail the same person twice.
// These pin all three, plus the audience definition.

const ROWS = [
  { user_id: 'user-1', org_id: 'org-1', email: 'dormant1@example.com', created_at: '2026-07-01T00:00:00Z' },
  { user_id: 'user-2', org_id: 'org-2', email: 'dormant2@example.com', created_at: '2026-07-02T00:00:00Z' },
];

function withStubs({ rows = ROWS, sendResult = { ok: true } } = {}, run) {
  const originalQuery = db.query;
  const originalSend = resendClient.sendEmail;
  const originalRecord = productEvents.recordProductEvent;
  const captured = { queries: [], sends: [], events: [] };

  db.query = async (text, params) => {
    captured.queries.push({ text, params });
    return { rows };
  };
  resendClient.sendEmail = async (input) => {
    captured.sends.push(input);
    return sendResult;
  };
  productEvents.recordProductEvent = async (actor, input) => {
    captured.events.push({ actor, input });
    return input;
  };

  return (async () => {
    try {
      return await run(captured);
    } finally {
      db.query = originalQuery;
      resendClient.sendEmail = originalSend;
      productEvents.recordProductEvent = originalRecord;
    }
  })();
}

test('the default is a dry run — a campaign never fires by accident', async () => {
  await withStubs({}, async (captured) => {
    const result = await svc.sendDormantReactivationEmails();
    assert.equal(result.dryRun, true);
    assert.equal(result.sent, 0);
    assert.equal(result.total, 2);
    assert.equal(captured.sends.length, 0, 'NOTHING may leave the building without --apply');
    assert.equal(captured.events.length, 0, 'and a dry run must not mark anyone as sent');
    assert.deepEqual(
      result.recipients.map((r) => r.email),
      ['dormant1@example.com', 'dormant2@example.com'],
      'the audience is returned so a human can read it before sending',
    );
  });
});

test('with apply it sends once per recipient and marks each one', async () => {
  await withStubs({}, async (captured) => {
    process.env.RESEND_API_KEY = 'test-key';
    try {
      const result = await svc.sendDormantReactivationEmails({ apply: true });
      assert.equal(result.sent, 2);
      assert.equal(captured.sends.length, 2);
      assert.equal(captured.events.length, 2, 'every send is marked, or a re-run would mail them again');
      for (const e of captured.events) {
        assert.equal(e.input.event_name, svc.SENT_EVENT);
        assert.equal(e.actor.type, 'user', 'marked per user, which is how the audience query excludes them next time');
      }
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });
});

test('a failed send is not marked, so it can be retried', async () => {
  await withStubs({ sendResult: { skipped: true, reason: 'missing_fields' } }, async (captured) => {
    process.env.RESEND_API_KEY = 'test-key';
    try {
      const result = await svc.sendDormantReactivationEmails({ apply: true });
      assert.equal(result.sent, 0);
      assert.equal(captured.events.length, 0, 'marking an unsent email would silently drop that person');
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });
});

test('apply without an API key sends nothing rather than failing silently', async () => {
  await withStubs({}, async (captured) => {
    delete process.env.RESEND_API_KEY;
    const result = await svc.sendDormantReactivationEmails({ apply: true });
    assert.equal(result.skipped, true);
    assert.equal(captured.sends.length, 0);
    assert.equal(captured.events.length, 0);
  });
});

test('the audience excludes anyone who engaged, opted out, or already got it', async () => {
  await withStubs({}, async (captured) => {
    await svc.findRecipients();
    const { text, params } = captured.queries[0];
    assert.match(text, /weekly_digest_unsubscribed/, 'one opt-out stops all marketing mail');
    assert.match(text, /NOT EXISTS/, 'engagement and prior-send are exclusions, not filters');
    assert.match(text, /created_at <= NOW\(\)/, 'too-new accounts belong to the activation follow-up, not this');
    assert.ok(params[0].includes('mcp_config_copied'), 'copying a config is the dormancy line');
    assert.ok(
      params[0].includes('oauth_consent_approved') && params[0].includes('first_sync_completed'),
      'someone who took the hosted path never copied a config and must not count as dormant',
    );
    assert.equal(params[1], svc.SENT_EVENT, 'prior sends are excluded by the marker');
    assert.equal(params[3], '+clerk_test', 'journey-test signups are not real mailboxes');
  });
});

test('the email carries an unsubscribe link and the real offer', async () => {
  const html = svc.renderDormantHtml('https://api.deerdawn.com/api/v1/email/unsubscribe?u=user-1&t=tok');
  assert.match(html, /unsubscribe\?u=user-1&amp;t=tok/, 'per-user unsubscribe, HMAC-signed upstream');
  assert.match(html, />Unsubscribe</, 'and it is a visible link, not just a URL in the markup');
  assert.match(html, /api\.deerdawn\.com\/mcp/, 'the no-install URL is the point of the email');
  // Derived from plans.js, not pinned to a literal: the point of the assertion
  // is that the email agrees with what is actually charged, and an outbound
  // email is the one surface that cannot be corrected after it is sent. Pinning
  // "$10/month" is how this line survived a pricing change intact and wrong.
  const { PLANS } = require('../../src/config/plans');
  const pro = PLANS.developer_basic;
  assert.match(
    html,
    new RegExp(`\\$${pro.price}/month or \\$${pro.annual_price}/year`),
    'the offer in the email must match what plans.js actually sells',
  );
  const free = PLANS.free.limits;
  assert.match(
    html,
    Number.isFinite(free.included_projects)
      ? new RegExp(`free for ${free.included_projects} projects`)
      : /free for unlimited projects/,
    'the email must describe the free tier plans.js actually enforces',
  );
  assert.match(html, new RegExp(`${free.history_days} days of history`));
  assert.ok(!/\$200/.test(html), 'no unreconciled price anchor');
});

test('the postal address is added by the transport, not the template', async () => {
  // The template deliberately omits it: resendClient injects it into EVERY
  // outbound email so no template can forget. This asserts the pairing actually
  // holds for this campaign's markup rather than assuming it.
  const html = svc.renderDormantHtml('https://example.com/unsub');
  assert.ok(!/Orange Street/.test(html), 'template does not hardcode the address');
  const withFooter = resendClient.withPostalFooter(html);
  assert.match(withFooter, /Orange Street/, 'transport supplies it — this is what makes the send compliant');
  assert.ok(
    withFooter.indexOf('Orange Street') < withFooter.indexOf('</body>'),
    'inside the body, where mail clients will render it',
  );
});
