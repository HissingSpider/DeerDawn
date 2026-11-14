/**
 * The operator view behind /admin/today.
 *
 * Two things are worth pinning here, and they are different in kind:
 *
 *   1. THE EXCLUSION. If the founder's workspace leaks into this list the page
 *      is a chart of one person, and — worse — it reads as traction. That
 *      workspace is by far the highest-activity one in the product, so the
 *      failure is not subtle-but-harmless, it is the loudest row on the page.
 *      Tested at the predicate level AND at the shape level, because the
 *      is_platform_staff arm and the synthetic-email arm fail independently.
 *
 *   2. THE INDEX. The recorded landmine is a query whose filter column leads no
 *      index, scanning every row and tripping the 8s DB breaker. A unit test
 *      cannot measure a plan, so it pins the thing that DOES survive in source:
 *      that the window filter is on the column the new index leads with, and
 *      that the first-ever probe stays owner-scoped rather than aggregating the
 *      whole table. Both were verified against a 400k-row table with
 *      EXPLAIN ANALYZE when written (seq scan 80ms -> bitmap index scan 0.9ms);
 *      this guards the shape from drifting back.
 *
 * Run: node --test tests/unit/operator-today.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../src/config/db');
const internal = require('../../src/services/internalAccounts');
const svc = require('../../src/services/operatorToday');

/** Swap db.query for a stub, run fn, always restore. */
async function withQuery(stub, fn) {
  const original = db.query;
  db.query = stub;
  try {
    return await fn();
  } finally {
    db.query = original;
  }
}

const captureOnce = (rows = []) => {
  const calls = [];
  const stub = async (text, params, orgId) => {
    calls.push({ text, params, orgId });
    return { rows };
  };
  return { calls, stub };
};

// ── The exclusion ────────────────────────────────────────────────────────────

test('platform staff are internal regardless of their email address', () => {
  // The founder signs in with a personal address, not @deerdawn.com. An
  // email-pattern-only filter therefore misses exactly the account it most
  // needs to drop, which is why the flag is the primary arm.
  assert.equal(
    internal.isInternalIdentity({ email: 'founder.personal@example.com', isPlatformStaff: true }),
    true,
  );
  assert.equal(
    internal.isInternalIdentity({ email: 'founder.personal@example.com', isPlatformStaff: false }),
    false,
    'a personal address alone must NOT exclude a real customer',
  );
});

test('synthetic addresses are internal even with no staff flag', () => {
  for (const email of [
    'journey+clerk_test@example.com',
    'ops@deerdawn.com',
    'anthropic-review@somewhere.test',
    'MIXED+CLERK_TEST@Example.COM',
  ]) {
    assert.equal(internal.isInternalIdentity({ email }), true, `${email} must be internal`);
  }
});

test('a missing email is not synthetic', () => {
  // Absence of evidence is not evidence. An unattributed row is surfaced as
  // unknown rather than silently dropped — dropping it would understate the
  // one number this page exists to report.
  assert.equal(internal.isSyntheticEmail(null), false);
  assert.equal(internal.isInternalIdentity({ email: null, isPlatformStaff: false }), false);
});

test('real customer addresses survive the filter', () => {
  for (const email of ['alice@realcustomer.io', 'bob@another.dev', 'deerdawn@gmail.com']) {
    assert.equal(internal.isInternalIdentity({ email }), false, `${email} is a customer`);
  }
});

test('the marker is matched with POSITION, never LIKE', () => {
  // '_' is a LIKE wildcard, so LIKE '%+clerk_test%' also matches '+clerkXtest'.
  // POSITION with a bound parameter is literal. Same trap already pinned on the
  // activation follow-up query; repeated because it is the same marker string.
  const { sql, params } = internal.internalIdentitySql(
    { emailExpr: 'i.email', platformStaffExpr: 'i.is_platform_staff' },
    3,
  );
  assert.ok(/POSITION\(\$3 IN lower\(COALESCE\(i\.email, ''\)\)\)/.test(sql), 'uses POSITION');
  assert.ok(!/LIKE/i.test(sql), 'must not use LIKE on the markers');
  assert.ok(sql.includes('COALESCE(i.is_platform_staff, FALSE) = TRUE'), 'staff flag is the first arm');
  assert.deepEqual(params, ['@deerdawn.com', '+clerk_test', 'anthropic-review@']);
});

test('the markers are bound parameters, not inlined into the SQL', () => {
  const { sql } = internal.internalIdentitySql(
    { emailExpr: 'i.email', platformStaffExpr: 'i.is_platform_staff' },
    1,
  );
  for (const marker of internal.SYNTHETIC_EMAIL_MARKERS) {
    assert.ok(!sql.includes(marker), `${marker} must not be inlined into the query text`);
  }
});

test('every marker placeholder lines up with its slot in the bound params', async () => {
  // THE FAILURE THIS CATCHES, and it is silent in both directions. The
  // exclusion fragment is handed a starting placeholder index by
  // `buildQuery(2)` — a literal that has to match how many parameters the
  // window filter binds ahead of it. Add a third window parameter and forget
  // that 2, and the SQL reads `$3` for a marker while `$3` is now the new
  // value: the query still runs, still returns rows, and quietly filters on the
  // wrong strings — either leaking the founder's workspace onto the page or
  // emptying it. Nothing throws.
  //
  // The two tests above call internalIdentitySql DIRECTLY with an index they
  // choose, so neither can see this. Assert alignment on the ASSEMBLED query.
  const { calls, stub } = captureOnce();
  await withQuery(stub, () => svc.getOperatorToday({}));
  const { text, params } = calls[0];

  for (const marker of internal.SYNTHETIC_EMAIL_MARKERS) {
    const slot = params.indexOf(marker);
    assert.notEqual(slot, -1, `${marker} must be bound, not inlined`);
    assert.ok(
      text.includes(`POSITION($${slot + 1} IN `),
      `${marker} is bound at $${slot + 1}, but no POSITION clause reads that placeholder — `
        + 'the exclusion is filtering on the wrong value.',
    );
  }

  const placeholders = [...text.matchAll(/POSITION\(\$(\d+) IN /g)].map((m) => Number(m[1]));
  assert.equal(
    placeholders.length,
    internal.SYNTHETIC_EMAIL_MARKERS.length,
    'one POSITION clause per marker, no more and no fewer',
  );
  assert.equal(
    new Set(placeholders).size,
    placeholders.length,
    'two markers sharing a placeholder means one of them is never checked',
  );
});

// ── The query shape (the index contract) ─────────────────────────────────────

test('the window filter is on created_at — the column the new index leads with', async () => {
  const { calls, stub } = captureOnce();
  await withQuery(stub, () => svc.getOperatorToday({ now: new Date('2026-08-29T18:00:00Z') }));
  const { text, params, orgId } = calls[0];

  assert.equal(orgId, 'org-system', 'cross-account read runs under the system context');
  assert.ok(
    /FROM context_session_loads l\s+WHERE l\.created_at >= \$1\s+AND l\.created_at <\s+\$2/.test(text),
    'the outer filter must be a bounded range on created_at',
  );
  assert.equal(params[0], '2026-08-29T00:00:00.000Z', 'window starts at UTC midnight');
  assert.equal(params[1], '2026-08-29T18:00:00.000Z', 'window ends now');
});

test('the first-ever probe stays scoped to one owner_key', async () => {
  const { calls, stub } = captureOnce();
  await withQuery(stub, () => svc.getOperatorToday({}));
  const { text } = calls[0];

  // The cheap shape: an EXISTS seeking the owner-leading index once per person
  // in the window. The expensive shape it must never become: a GROUP BY over
  // the whole table to find each owner's MIN(created_at).
  assert.ok(
    /NOT EXISTS \(\s*SELECT 1\s*FROM context_session_loads prior\s*WHERE prior\.owner_key = l\.owner_key/.test(text),
    'first-ever must be an owner-scoped EXISTS',
  );
  assert.ok(
    !/GROUP BY\s+(prior\.)?owner_key/.test(text),
    'first-ever must not aggregate the whole table by owner',
  );
});

test('identity resolves by user_id first, then the workspace owner', async () => {
  const { calls, stub } = captureOnce();
  await withQuery(stub, () => svc.getOperatorToday({}));
  const { text } = calls[0];

  assert.ok(text.includes('LEFT JOIN users du ON du.user_id = w.user_id'), 'primary-key lookup');
  // The fallback arm is what catches an unattributed founder row (user_id NULL).
  // Its join column is org_id, which leads idx_users_org_id.
  assert.ok(/WHERE u\.org_id = w\.owner_key/.test(text), 'fallback joins on the indexed org_id');
});

test('the brief body is never read — only the plaintext project name', async () => {
  const { calls, stub } = captureOnce();
  await withQuery(stub, () => svc.getOperatorToday({}));
  const { text } = calls[0];
  // context_projects.context is encrypted at rest and would decrypt per row for
  // no benefit. The name is plaintext; nothing else from the project is needed.
  assert.ok(text.includes('p.project_name'), 'selects the project name');
  assert.ok(!/p\.context\b/.test(text), 'must not select the encrypted context blob');
});

// ── Window sizing ────────────────────────────────────────────────────────────

test('days widens the window backwards from today, and is clamped', async () => {
  const cases = [
    { days: 1, start: '2026-08-29T00:00:00.000Z' },
    { days: 7, start: '2026-08-23T00:00:00.000Z' },
    { days: 0, start: '2026-08-29T00:00:00.000Z' },
    { days: -5, start: '2026-08-29T00:00:00.000Z' },
    { days: 'garbage', start: '2026-08-29T00:00:00.000Z' },
    { days: 9999, start: '2026-07-30T00:00:00.000Z' },
  ];
  for (const { days, start } of cases) {
    const { calls, stub } = captureOnce();
    await withQuery(stub, () =>
      svc.getOperatorToday({ days, now: new Date('2026-08-29T18:00:00Z') }));
    assert.equal(calls[0].params[0], start, `days=${days}`);
  }
});

test('the widest window is MAX_WINDOW_DAYS', async () => {
  const { calls, stub } = captureOnce();
  const res = await withQuery(stub, () =>
    svc.getOperatorToday({ days: 10000, now: new Date('2026-08-29T18:00:00Z') }));
  assert.equal(res.window_days, svc.MAX_WINDOW_DAYS);
  assert.ok(calls[0].params[0] < calls[0].params[1]);
});

// ── The rows it returns ──────────────────────────────────────────────────────

test('shapes rows and counts without inventing anything', async () => {
  const rows = [
    {
      person_key: 'u_alice', owner_key: 'org_1', email: 'alice@realcustomer.io',
      briefs: '2', projects: '2', tools: '2',
      latest_project: 'Marketing site', latest_tool: 'cursor',
      first_brief_at: new Date('2026-08-29T14:04:00Z'),
      last_brief_at: new Date('2026-08-29T16:04:00Z'),
      is_first_ever: true,
    },
    {
      person_key: 'org_nouser', owner_key: 'org_nouser', email: null,
      briefs: '1', projects: '0', tools: '1',
      latest_project: null, latest_tool: 'chatgpt',
      first_brief_at: new Date('2026-08-29T16:59:00Z'),
      last_brief_at: new Date('2026-08-29T16:59:00Z'),
      is_first_ever: false,
    },
  ];
  const { stub } = captureOnce(rows);
  const res = await withQuery(stub, () =>
    svc.getOperatorToday({ now: new Date('2026-08-29T18:00:00Z') }));

  assert.equal(res.people_count, 2);
  assert.equal(res.first_timers, 1);
  assert.equal(res.briefs_count, 3, 'briefs are summed from the rows, not counted separately');

  assert.equal(res.people[0].briefs, 2, 'pg bigint strings become numbers');
  assert.equal(res.people[0].first_brief_at, '2026-08-29T14:04:00.000Z');
  assert.equal(res.people[0].is_first_ever, true);

  // An unresolved identity stays null. The page renders the workspace key; it
  // does not guess a name, and it is not dropped from the count.
  assert.equal(res.people[1].email, null);
  assert.equal(res.people[1].latest_project, null);
  assert.equal(res.people[1].is_first_ever, false);
});

test('an empty day is a real answer, not an error', async () => {
  const { stub } = captureOnce([]);
  const res = await withQuery(stub, () => svc.getOperatorToday({}));
  assert.equal(res.people_count, 0);
  assert.equal(res.briefs_count, 0);
  assert.equal(res.first_timers, 0);
  assert.deepEqual(res.people, []);
});

test('no rate or score is reported', async () => {
  // Deliberate: at this volume a one-day rate is noise, and the growth protocol
  // says a one-day move is not a result. Counts only.
  const { stub } = captureOnce([]);
  const res = await withQuery(stub, () => svc.getOperatorToday({}));
  // Segment-anchored: `generated_at` contains "rate" and is not a metric.
  for (const key of Object.keys(res)) {
    assert.ok(
      !/(^|_)(rate|score|pct|percent|ratio|avg|estimated)($|_)/i.test(key),
      `${key} looks like an invented metric`,
    );
  }
});
