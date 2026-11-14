const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const resendClient = require('../../src/services/email/resendClient');
const productEvents = require('../../src/services/productEventsService');
const svc = require('../../src/services/email/conciergeRecovery');
const segments = require('../../src/services/email/lifecycleSegments');

// A-3 tells a stranger what went wrong on their own machine. The draft's stated
// failure mode is a diagnosis that turns out to be wrong on the call, so what
// these pin is mostly restraint:
//   1. it never sends unless a human explicitly asks,
//   2. it never asserts a cause the event stream cannot support,
//   3. it never sells anything to someone the product has never worked for,
//   4. it cannot mail the same person twice,
//   5. and it cannot reach anyone A-4 would also mail.

const ROWS = [
  { user_id: 'user-1', org_id: 'org-1', email: 'stuck1@example.com', created_at: '2026-07-01T00:00:00Z' },
];

// db.query is called twice: once for the audience, once for the ladder events.
// The stub answers by shape so a test can supply both.
function withStubs({ rows = ROWS, events = [], sendResult = { ok: true } } = {}, run) {
  const originalQuery = db.query;
  const originalSend = resendClient.sendEmail;
  const originalRecord = productEvents.recordProductEvent;
  const captured = { queries: [], sends: [], events: [] };

  db.query = async (text, params) => {
    captured.queries.push({ text, params });
    if (/FROM product_events/.test(text) && /ORDER BY created_at ASC/.test(text)) {
      return { rows: events };
    }
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

const ev = (name, extra = {}) => ({
  user_id: 'user-1', org_id: 'org-1', event_name: name, metadata: {}, created_at: '2026-07-02T00:00:00Z', ...extra,
});

test('the default is a dry run — a campaign never fires by accident', async () => {
  await withStubs({ events: [ev('mcp_config_copied', { metadata: { tool: 'cursor' } })] }, async (captured) => {
    const result = await svc.sendConciergeRecoveryEmails();
    assert.equal(result.dryRun, true);
    assert.equal(result.sent, 0);
    assert.equal(captured.sends.length, 0, 'NOTHING may leave the building without --apply');
    assert.equal(captured.events.length, 0, 'and a dry run must not mark anyone as sent');
    assert.equal(result.recipients[0].diagnosis.stepPhrase, 'copying the config',
      'the derived diagnosis is returned so a human can read it before it is sent');
  });
});

test('with apply it sends once, marks the recipient, and records what it claimed', async () => {
  await withStubs({ events: [ev('mcp_config_copied', { metadata: { tool: 'claude_code' } })] }, async (captured) => {
    process.env.RESEND_API_KEY = 'test-key';
    try {
      const result = await svc.sendConciergeRecoveryEmails({ apply: true });
      assert.equal(result.sent, 1);
      assert.equal(captured.sends.length, 1);
      assert.equal(captured.sends[0].to, 'stuck1@example.com');
      assert.equal(captured.sends[0].emailType, svc.EMAIL_TYPE);

      assert.equal(captured.events.length, 1, 'the sent-marker is what makes a re-run safe');
      const marked = captured.events[0].input;
      assert.equal(marked.event_name, svc.SENT_EVENT);
      assert.equal(marked.metadata.variant, svc.VARIANT_STUCK);
      assert.equal(marked.metadata.last_event, 'mcp_config_copied',
        'what we diagnosed is recorded, so a reply can be read against what we actually claimed');
      assert.equal(marked.metadata.hypothesis_given, true);
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });
});

test('anyone already sent is excluded in SQL, not in JS', async () => {
  await withStubs({}, async (captured) => {
    await svc.sendConciergeRecoveryEmails();
    const audienceQuery = captured.queries[0];
    assert.match(audienceQuery.text, /NOT EXISTS[\s\S]*event_name = \$2/,
      'the sent-marker exclusion has to be in the query — a JS filter is one early return from a repeat send');
    assert.equal(audienceQuery.params[1], svc.SENT_EVENT);
  });
});

test('the audience is: attempted a connection, has no activation on record', async () => {
  await withStubs({}, async (captured) => {
    await svc.sendConciergeRecoveryEmails();
    const { text, params } = captured.queries[0];
    assert.match(text, /EXISTS[\s\S]*event_name = ANY\(\$1\)/, 'must have attempted something');
    assert.match(text, /NOT EXISTS[\s\S]*event_name = ANY\(\$6\)/, 'and must not have activated');
    assert.ok(params[0].includes('mcp_config_copied'), 'copying a config counts as an attempt');
    assert.ok(params[0].includes('oauth_consent_viewed'),
      'so does reaching the consent screen — the hosted path has no config to copy');
    assert.ok(params[0].includes('mcp_runtime_started'), 'and so does getting a session running');
    assert.deepEqual(params[5], segments.ACTIVATION_EVENTS);
    assert.equal(params[3], '+clerk_test', 'journey-test signups are not real mailboxes');
    assert.match(text, /weekly_digest_unsubscribed/, 'one opt-out stops all marketing mail');
  });
});

test('A-3 and A-4 cannot both reach the same person', async () => {
  // The two emails say incompatible things. Disjointness is by construction:
  // A-4 excludes everyone with an ENGAGED event, A-3 requires one.
  const a3Qualifying = [...segments.SETUP_ATTEMPT_EVENTS, ...segments.RUNTIME_EVENTS];
  for (const name of a3Qualifying) {
    assert.ok(
      segments.ENGAGED_EVENTS.includes(name),
      `${name} qualifies someone for A-3, so it must also disqualify them from A-4`,
    );
  }
});

test('a running MCP session with no activation gets the blind-spot email, not the stuck one', async () => {
  // These are the C-1a accounts: hosted start_session answered them and never
  // emitted an activation event. Telling them "the setup lost you" would be an
  // assertion the data cannot support.
  await withStubs({
    events: [ev('mcp_config_copied', { metadata: { tool: 'cursor' } }), ev('mcp_runtime_started')],
  }, async () => {
    const audience = await svc.buildAudience();
    assert.equal(audience[0].variant, svc.VARIANT_BLIND_SPOT);
    const html = svc.renderForVariant(audience[0].variant, { diagnosis: audience[0].diagnosis, unsubUrl: 'https://x/u' });
    assert.match(html, /can&rsquo;t tell from here/, 'it asks rather than tells');
    assert.doesNotMatch(html, /stopped at/, 'and never claims to know where they stopped');
  });
});

test('neither variant sells anything', async () => {
  const diagnosis = svc.deriveDiagnosis([ev('mcp_config_copied', { metadata: { tool: 'codex' } })]);
  for (const html of [
    svc.renderStuckHtml({ diagnosis, unsubUrl: 'https://x/u' }),
    svc.renderBlindSpotHtml({ unsubUrl: 'https://x/u' }),
  ]) {
    assert.doesNotMatch(html, /checkout|\$\d|Founding|upgrade|per month|\/year/i,
      'nothing is sold to someone the product has never worked for');
    assert.match(html, /https:\/\/x\/u/, 'but the unsubscribe link is always present');
  }
});

test('the email states the step as fact and the cause as an explicit guess', async () => {
  const diagnosis = svc.deriveDiagnosis([ev('mcp_config_copied', { metadata: { tool: 'claude_code' } })]);
  const html = svc.renderStuckHtml({ diagnosis, unsubUrl: 'https://x/u' });
  assert.match(html, /stopped at copying the config/);
  assert.match(html, /If I had to guess: the JSON config never applies to Claude Code/,
    'the cause is hedged in the copy because absence of an event is weak evidence');
});

test('with no supportable cause the guess sentence is dropped, not invented', async () => {
  // Config copied, tool unknown: the step is still observed, the cause is not.
  const diagnosis = svc.deriveDiagnosis([ev('mcp_config_copied')]);
  assert.equal(diagnosis.hypothesis, null);
  const html = svc.renderStuckHtml({ diagnosis, unsubUrl: 'https://x/u' });
  assert.match(html, /stopped at copying the config/);
  assert.doesNotMatch(html, /If I had to guess/);
  assert.match(html, /not something you did wrong/, 'the reassurance survives without the guess');
});

test('oauth_consent_failed is held back from --apply — its cause has to be read', async () => {
  await withStubs({ events: [ev('oauth_consent_viewed'), ev('oauth_consent_failed', { metadata: { reason: 'approve_failed' } })] },
    async (captured) => {
      process.env.RESEND_API_KEY = 'test-key';
      try {
        const result = await svc.sendConciergeRecoveryEmails({ apply: true });
        assert.equal(result.sent, 0);
        assert.equal(result.held, 1);
        assert.equal(captured.sends.length, 0, 'no canned line exists for this case, so nothing goes out');

        // ...until a human supplies the line they read in the failure reason.
        const withOverride = await svc.sendConciergeRecoveryEmails({
          apply: true, onlyEmail: 'stuck1@example.com', diagnosisOverride: 'the approve step 500d on our side',
        });
        assert.equal(withOverride.sent, 1);
        assert.match(captured.sends[0].html, /If I had to guess: the approve step 500d on our side/);
      } finally {
        delete process.env.RESEND_API_KEY;
      }
    });
});

test('the diagnosis reads the whole ladder, not just the newest event', async () => {
  // A broken hand-off outranks the config copy that preceded it: the person got
  // further than the config step, so the config is not what stopped them.
  const diagnosis = svc.deriveDiagnosis([
    ev('setup_path_selected', { metadata: { tool: 'claude_code' } }),
    ev('mcp_config_copied', { metadata: { tool: 'claude_code' } }),
    ev('oauth_consent_viewed', { metadata: { has_request: 0 }, created_at: '2026-07-03T00:00:00Z' }),
  ]);
  assert.equal(diagnosis.lastEvent, 'oauth_consent_viewed');
  assert.equal(diagnosis.hypothesis, 'your tool sent you to the sign-in page without the actual request attached');
});

test('hunting through the tool picker is diagnosed as bad instructions', async () => {
  const diagnosis = svc.deriveDiagnosis([
    ev('setup_path_selected', { metadata: { tool: 'cursor' } }),
    ev('setup_path_changed', { metadata: { tool: 'claude_code' } }),
  ]);
  assert.equal(diagnosis.hypothesis, 'you were sent instructions that didn’t match your setup');
});

test('no count, date or frequency ever reaches the reader', async () => {
  // The draft's rule: "You stopped at the connect step" is safe; "you tried four
  // times in March" invites a correction you cannot win. Asserted against the
  // VISIBLE text — stripping markup and entities — because a numeral in prose is
  // the failure and a numeral in a style attribute is not.
  const visible = (html) => html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');

  const diagnosis = svc.deriveDiagnosis([
    ev('mcp_config_copied', { metadata: { tool: 'cursor' } }),
    ev('mcp_config_copied', { metadata: { tool: 'cursor' } }),
    ev('mcp_config_copied', { metadata: { tool: 'cursor' } }),
  ]);
  assert.equal(diagnosis.hypothesis, 'the config looks right — the tool almost certainly needs a restart before it loads it',
    'three copies is still one diagnosis; the count is not part of it');

  for (const html of [
    svc.renderStuckHtml({ diagnosis, unsubUrl: 'https://x/u' }),
    svc.renderBlindSpotHtml({ unsubUrl: 'https://x/u' }),
  ]) {
    assert.doesNotMatch(visible(html), /\d/,
      'no digit may reach the reader — not a count, not a date, not a frequency');
  }
});
