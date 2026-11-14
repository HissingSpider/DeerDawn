const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const { recordProductEvent, getProductEventSummary } = require('../../src/services/productEventsService');

test('recordProductEvent normalizes and writes an append-only product event', async () => {
  const originalQuery = db.query;
  const captured = [];

  db.query = async (text, params, orgId) => {
    captured.push({ text, params, orgId });
    return { rows: [] };
  };

  try {
    const event = await recordProductEvent(
      { type: 'user', id: 'user-123', org_id: 'org-123' },
      {
        event_name: 'dashboard_bootstrap_loaded',
        source: 'dashboard',
        surface: 'codex',
        path: '/dashboard',
        session_id: 'sess-123',
        duration_ms: 3210,
        metadata: { runtime_verified_count: 1 },
      }
    );

    assert.equal(event.event_name, 'dashboard_bootstrap_loaded');
    assert.equal(event.org_id, 'org-123');
    assert.equal(event.user_id, 'user-123');
    assert.equal(event.duration_ms, 3210);
    assert.ok(captured[0].text.includes('INSERT INTO product_events'));
    assert.ok(captured[1].text.includes('UPDATE product_events'));
    assert.equal(captured[0].orgId, 'org-123');
  } finally {
    db.query = originalQuery;
  }
});

test('getProductEventSummary returns compact totals and funnel aggregates', async () => {
  const originalQuery = db.query;
  let call = 0;

  db.query = async () => {
    call += 1;
    if (call === 1) return { rows: [{ total_events: '4', events_last_24h: '3' }] };
    if (call === 2) {
      return {
        rows: [{
          onboarding_views: '2',
          onboarding_step_completions: '5',
          onboarding_completions: '1',
          avg_onboarding_duration_ms: '42000',
          median_onboarding_duration_ms: '42000',
        }],
      };
    }
    if (call === 3) {
      return {
        rows: [{
          signup_starts: '3',
          signup_successes: '2',
          signup_failures: '1',
          checkout_starts: '2',
          checkout_failures: '1',
          import_starts: '1',
          import_successes: '1',
          import_failures: '0',
          mcp_start_sessions: '4',
        }],
      };
    }
    return {
      rows: [{
        event_name: 'onboarding_completed',
        created_at: '2026-05-23T00:00:00.000Z',
        source: 'dashboard',
        surface: 'codex',
        path: '/onboarding',
        metadata: { step_count: 5 },
      }],
    };
  };

  try {
    const summary = await getProductEventSummary({ org_id: 'org-123' });
    assert.equal(summary.totals.total_events, 4);
    assert.equal(summary.onboarding.completions, 1);
    assert.equal(summary.onboarding.median_duration_ms, 42000);
    assert.equal(summary.funnel.signup_successes, 2);
    assert.equal(summary.funnel.mcp_start_sessions, 4);
    assert.equal(summary.recent[0].event_name, 'onboarding_completed');
  } finally {
    db.query = originalQuery;
  }
});
