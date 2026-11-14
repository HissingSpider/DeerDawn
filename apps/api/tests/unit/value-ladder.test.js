'use strict';

// The value ladder's decisions, without a database: which step a person is on,
// and which one email (if any) is due. The SQL that gathers the facts is
// exercised against a real database in tests/integration/value-ladder.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const ladder = require('../../src/services/email/valueLadder');
const { STEP, EMAIL } = ladder;

const NOW = new Date('2026-10-20T15:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const dayAgo = (n) => daysAgo(n).slice(0, 10);

function facts(over = {}) {
    return {
        userId: 'u1',
        email: 'a@example.com',
        createdAt: daysAgo(5),
        authorized: true,
        authorizedClient: 'ChatGPT',
        usedDays: [],
        mainClient: 'chatgpt_web',
        firstSaveAt: null,
        ownProjects: 0,
        invitesSent: 0,
        workspaceMembers: 1,
        paid: false,
        lastLifecycleSentAt: null,
        morningAfterSent: false,
        sent: new Set(),
        habitEmailSentAt: null,
        milestones: new Set(),
        ...over,
    };
}

test('ladder: steps are measured in tool calls and saves', () => {
    assert.equal(ladder.ladderOf(facts()).step, STEP.JOINED);
    assert.equal(ladder.ladderOf(facts({ usedDays: [dayAgo(3)] })).step, STEP.USED);
    assert.equal(ladder.ladderOf(facts({ usedDays: [dayAgo(3)], firstSaveAt: daysAgo(3) })).step, STEP.SAVED);
    const returned = ladder.ladderOf(facts({ usedDays: [dayAgo(3), dayAgo(1)], firstSaveAt: daysAgo(3) }));
    assert.equal(returned.step, STEP.RETURNED);
    assert.equal(returned.firstReturnDay, dayAgo(1));
    const habit = ladder.ladderOf(facts({ usedDays: [dayAgo(5), dayAgo(3), dayAgo(1)], firstSaveAt: daysAgo(5) }));
    assert.equal(habit.step, STEP.HABIT);
    assert.equal(habit.habitDay, dayAgo(1));
});

test('ladder: using it again the SAME day as the first save is not a return', () => {
    const l = ladder.ladderOf(facts({ usedDays: [dayAgo(2), dayAgo(2)], firstSaveAt: daysAgo(2) }));
    assert.equal(l.step, STEP.SAVED);
});

test('ladder: three days of use without a later-day return is not a habit', () => {
    // Saved on the last of the three days: nothing has come back yet.
    const l = ladder.ladderOf(facts({ usedDays: [dayAgo(5), dayAgo(3), dayAgo(1)], firstSaveAt: daysAgo(1) }));
    assert.equal(l.step, STEP.SAVED);
});

test('due: a never-saved account gets the unused nudge on days 4-10 only', () => {
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(2) }), NOW), null);
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(5) }), NOW), EMAIL.NUDGE_UNUSED);
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(12) }), NOW), null);
    assert.equal(ladder.dueEmail(facts({ sent: new Set([EMAIL.NUDGE_UNUSED]) }), NOW), null);
});

test('due: 48 hours of quiet after ANY lifecycle email', () => {
    assert.equal(ladder.dueEmail(facts({ lastLifecycleSentAt: daysAgo(1) }), NOW), null);
    assert.equal(ladder.dueEmail(facts({ lastLifecycleSentAt: daysAgo(2.1) }), NOW), EMAIL.NUDGE_UNUSED);
});

test('due: a saver the morning-after brief never reached is nudged; one it reached is left to it', () => {
    const saver = { usedDays: [dayAgo(6)], firstSaveAt: daysAgo(6), createdAt: daysAgo(6) };
    assert.equal(ladder.dueEmail(facts(saver), NOW), EMAIL.NUDGE_SAVED);
    assert.equal(ladder.dueEmail(facts({ ...saver, morningAfterSent: true }), NOW), null);
    assert.equal(ladder.dueEmail(facts({ ...saver, firstSaveAt: daysAgo(2), usedDays: [dayAgo(2)] }), NOW), null);
});

test('due: the first return is congratulated within 3 days, never weeks later', () => {
    const base = { firstSaveAt: daysAgo(4), createdAt: daysAgo(4) };
    assert.equal(ladder.dueEmail(facts({ ...base, usedDays: [dayAgo(4), dayAgo(1)] }), NOW), EMAIL.RETURNED);
    // Returned 8 days ago, quiet since: no congratulations, the quiet nudge instead.
    const old = { firstSaveAt: daysAgo(10), createdAt: daysAgo(10), usedDays: [dayAgo(10), dayAgo(8)] };
    assert.equal(ladder.dueEmail(facts(old), NOW), EMAIL.NUDGE_RETURNED);
    assert.equal(ladder.dueEmail(facts({ ...old, sent: new Set([EMAIL.NUDGE_RETURNED]) }), NOW), null);
});

test('due: habit, then upgrade only with a paid signal, on Free, 3+ days after the habit email', () => {
    const habit = { firstSaveAt: daysAgo(6), createdAt: daysAgo(6), usedDays: [dayAgo(6), dayAgo(3), dayAgo(1)] };
    assert.equal(ladder.dueEmail(facts(habit), NOW), EMAIL.HABIT);
    const afterHabit = { ...habit, sent: new Set([EMAIL.HABIT]), habitEmailSentAt: daysAgo(4) };
    assert.equal(ladder.dueEmail(facts(afterHabit), NOW), null, 'no paid signal: nothing');
    assert.equal(ladder.dueEmail(facts({ ...afterHabit, ownProjects: 2 }), NOW), EMAIL.UPGRADE);
    assert.equal(ladder.dueEmail(facts({ ...afterHabit, ownProjects: 2, paid: true }), NOW), null, 'already paying');
    assert.equal(ladder.dueEmail(facts({ ...afterHabit, ownProjects: 2, habitEmailSentAt: daysAgo(1) }), NOW), null);
});

test('due: nobody is sent a nudge for a step below the one they reached', () => {
    const habit = { firstSaveAt: daysAgo(30), createdAt: daysAgo(30), usedDays: [dayAgo(30), dayAgo(20), dayAgo(9)] };
    assert.equal(ladder.dueEmail(facts(habit), NOW), null);
});

test('upgrade signal: a teammate means Team, a second project means Pro', () => {
    assert.equal(ladder.upgradeSignal(facts({ invitesSent: 1, ownProjects: 3 })), 'team');
    assert.equal(ladder.upgradeSignal(facts({ workspaceMembers: 2 })), 'team');
    assert.equal(ladder.upgradeSignal(facts({ ownProjects: 2 })), 'pro');
    assert.equal(ladder.upgradeSignal(facts({ ownProjects: 1 })), null);
});

test('copy: every email renders, names the tool they use, and carries the unsubscribe link', () => {
    const unsubUrl = 'https://api.example/unsub?u=1';
    const brief = { projectName: 'Atlas', lines: { task: 'Ship billing', decision: 'Use Stripe', next: 'Write the webhook' } };
    for (const type of Object.values(EMAIL)) {
        const f = facts({ ownProjects: 2 });
        const { subject, text } = ladder.render(type, f, { brief, unsubUrl });
        assert.ok(subject && subject.length < 90, `${type} subject`);
        assert.ok(text.includes(unsubUrl), `${type} unsubscribe`);
        assert.ok(!/undefined|null|NaN/.test(text), `${type} has a hole: ${text}`);
    }
    const chatgpt = ladder.render(EMAIL.NUDGE_SAVED, facts(), { brief, unsubUrl }).text;
    assert.match(chatgpt, /@DeerDawn where did I leave off\?/);
    assert.match(chatgpt, /Working on: Ship billing/);
    const claude = ladder.render(EMAIL.NUDGE_SAVED, facts({ mainClient: 'claude_web' }), { brief, unsubUrl }).text;
    assert.match(claude, /Where did I leave off\? Check DeerDawn/);
});

test('copy: an account with no connection is sent to /start, never told it is connected', () => {
    const { text } = ladder.render(EMAIL.NUDGE_UNUSED, facts({ authorized: false, mainClient: null, authorizedClient: null }), { unsubUrl: 'u' });
    assert.match(text, /not connected/);
    assert.match(text, /\/start\?/);
});

test('copy: the only link to the website outside /start is the pricing page in the upgrade email', () => {
    const brief = { projectName: 'Atlas', lines: { task: 'x' } };
    for (const type of Object.values(EMAIL)) {
        const { text } = ladder.render(type, facts({ ownProjects: 2 }), { brief, unsubUrl: 'UNSUB' });
        const links = (text.match(/https?:\/\/\S+/g) || []).filter((l) => l !== 'UNSUB');
        if (type === EMAIL.UPGRADE) assert.ok(links.every((l) => l.includes('/pricing?')), links.join());
        else if (type === EMAIL.STILL_THERE) assert.equal(links.length, 1, links.join());
        else assert.deepEqual(links, [], `${type}: ${links.join()}`);
    }
});

// ── Day 21: "still there?" ───────────────────────────────────────────────────

test('due: day 21-35, below a first return, gets the one check-in', () => {
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(20) }), NOW), null, 'too early');
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(21) }), NOW), EMAIL.STILL_THERE);
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(28) }), NOW), EMAIL.STILL_THERE);
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(35) }), NOW), EMAIL.STILL_THERE);
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(36) }), NOW), null, 'too late: no backlog');
    // Used but never saved, and saved but never came back: both are asked.
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(25), usedDays: [dayAgo(24)] }), NOW), EMAIL.STILL_THERE);
    const saver = { createdAt: daysAgo(25), usedDays: [dayAgo(20)], firstSaveAt: daysAgo(20) };
    assert.equal(ladder.ladderOf(facts(saver)).step, STEP.SAVED);
    assert.equal(ladder.dueEmail(facts(saver), NOW), EMAIL.STILL_THERE);
});

test('due: the check-in is sent once per person, ever', () => {
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(25), sent: new Set([EMAIL.STILL_THERE]) }), NOW), null);
    // Earlier rungs having been sent does not stop it.
    assert.equal(ladder.dueEmail(facts({ createdAt: daysAgo(25), sent: new Set([EMAIL.NUDGE_UNUSED]) }), NOW), EMAIL.STILL_THERE);
});

test('due: nobody who reached a first return is asked', () => {
    const returned = { createdAt: daysAgo(25), firstSaveAt: daysAgo(24), usedDays: [dayAgo(24), dayAgo(22)] };
    assert.equal(ladder.ladderOf(facts(returned)).step, STEP.RETURNED);
    assert.equal(ladder.dueEmail(facts(returned), NOW), null);
    const habit = { createdAt: daysAgo(25), firstSaveAt: daysAgo(24), usedDays: [dayAgo(24), dayAgo(23), dayAgo(22)] };
    assert.equal(ladder.dueEmail(facts(habit), NOW), null);
    // The recorded milestone counts on its own, whatever today's facts say.
    const milestone = facts({ createdAt: daysAgo(25), milestones: new Set([ladder.RETURN_EVENT]) });
    assert.equal(ladder.dueEmail(milestone, NOW), null);
});

test('due: the check-in waits for 7 days of quiet after any lifecycle email', () => {
    const base = { createdAt: daysAgo(25) };
    assert.equal(ladder.dueEmail(facts({ ...base, lastLifecycleSentAt: daysAgo(3) }), NOW), null, '3 days: past 48h, inside the week');
    assert.equal(ladder.dueEmail(facts({ ...base, lastLifecycleSentAt: daysAgo(6.9) }), NOW), null);
    assert.equal(ladder.dueEmail(facts({ ...base, lastLifecycleSentAt: daysAgo(7.1) }), NOW), EMAIL.STILL_THERE);
    assert.equal(ladder.STILL_THERE_QUIET_HOURS, 168);
});

test('copy: the check-in is plain, from John, one question, one /start link', () => {
    const unsubUrl = 'https://api.example/unsub?u=1';
    const { subject, text } = ladder.render(EMAIL.STILL_THERE, facts({ createdAt: daysAgo(25) }), { unsubUrl });
    assert.equal(subject, 'Did something get in the way?');
    assert.match(text, /Did something get in the way\?/);
    assert.equal((text.match(/\?(\s|$)/g) || []).length, 1, 'one question');
    assert.match(text, /reply/i);
    assert.match(text, /\nJohn\n/);
    assert.ok(text.includes(unsubUrl));
    const links = (text.match(/https?:\/\/\S+/g) || []).filter((l) => l !== unsubUrl);
    assert.equal(links.length, 1);
    const url = new URL(links[0]);
    assert.equal(`${url.origin}${url.pathname}`, 'https://deerdawn.com/start');
    assert.equal(url.searchParams.get('utm_source'), 'lifecycle');
    assert.equal(url.searchParams.get('utm_campaign'), 'day21');
    // No em or en dashes, no emojis, no ellipsis character.
    assert.doesNotMatch(`${subject}\n${text}`, /[\u2013\u2014\u2026]/);
    assert.doesNotMatch(`${subject}\n${text}`, /\p{Extended_Pictographic}/u);
});

test('cooldown: every lifecycle sent event is read, the reactivation jobs included', () => {
    for (const name of ['activation_followup_email_sent', 'morning_after_brief_sent', 'morning_after_reminder_sent',
        'dormant_reactivation_email_sent', 'concierge_recovery_email_sent', ladder.SENT_EVENT]) {
        assert.ok(ladder.LIFECYCLE_SENT_EVENTS.includes(name), name);
    }
});

test('copy: an unknown client name never reaches the email verbatim', () => {
    const f = facts({ mainClient: null, authorizedClient: '<script>Evil Corp</script>' });
    assert.equal(ladder.toolOf(f), null);
    const { text } = ladder.render(EMAIL.NUDGE_UNUSED, f, { unsubUrl: 'u' });
    assert.ok(!text.includes('Evil'));
});

test('send window and enable flag', () => {
    const cfg = { hour: 14, windowHours: 8 };
    assert.equal(ladder.inSendWindow(new Date('2026-10-20T15:00:00Z'), cfg), true);
    assert.equal(ladder.inSendWindow(new Date('2026-10-20T03:00:00Z'), cfg), false);
    assert.equal(ladder.isEnabled({ VALUE_LADDER_EMAILS_ENABLED: 'true' }), true);
    assert.equal(ladder.isEnabled({}), false);
});
