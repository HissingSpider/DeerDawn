'use strict';

// Concierge recovery email (task A-3) — the largest leak in the funnel.
//
// Audience: people who tried to connect a tool and it did not work. They are
// the complement of A-4's dormant list (see lifecycleSegments.js): a setup
// attempt is on record, an activation is not.
//
// TWO VARIANTS, because the segment contains two genuinely different stories
// and telling either group the other's would be false:
//
//   setup_stuck — never got an MCP session running. The setup lost them, and
//     this email offers to finish it for them. This is the A-3 draft.
//
//   blind_spot  — DID get a session running (mcp_runtime_started and friends)
//     and still has no activation event. Until the C-1a fix, hosted start_session
//     answered from getWorkspaceOverview and never emitted context_delivered /
//     connection_established at all, so these accounts looked dead while very
//     possibly working fine. Writing "I can see the setup lost you" to them
//     would be an assertion the data cannot support. They get a question
//     instead. (This cohort should shrink to nothing on its own now that the
//     hosted path emits activation events — anyone still in it after a few weeks
//     is genuinely stuck and will be re-classified by the next run.)
//
// WHY THIS IS NOT IN THE SCHEDULER: same reason as A-4. A campaign whose
// audience is a query over history, fired on a timer, is a repeat-nag machine
// with only the sent-marker between it and mailing the same people forever.
// Fired by hand, dry run by default. See scripts/send-concierge-recovery.js.
//
// The A-3 draft specifies John sending "one at a time, each one carrying that
// person's own diagnosis line". --only=<email> in the CLI is that mode: this
// module exists so those sends still go through resendClient, which is the only
// thing that attaches the CAN-SPAM postal address and mints the per-user
// HMAC-signed unsubscribe link. A hand-sent copy from a mail client carries
// neither.
//
// HONESTY CONTRACT, from the draft's "Caveats that keep this honest":
//   * Absence of an event is weaker evidence than presence. oauth_consent_* only
//     started emitting 2026-08-05 and onboarding_connection_detected read zero
//     for everyone before PR #209 (2026-07-07). For an older account, "never
//     connected" can mean "we were not recording it".
//   * So the email states the observed step as fact and the cause as an explicit
//     guess ("If I had to guess: ..."), and drops the guess entirely when the
//     evidence does not support one. It never asserts a cause.
//   * No count, date or frequency is ever interpolated into the copy. The draft's
//     rule: "You stopped at the connect step" is safe; "you tried four times in
//     March" invites a correction you cannot win.

const db = require('../../config/db');
const resendClient = require('./resendClient');
const { unsubscribeUrl } = require('./weeklyDigest');
// Module object (not destructured) so tests can stub recordProductEvent.
const productEvents = require('../productEventsService');
const segments = require('./lifecycleSegments');

const SITE_URL = process.env.SITE_URL || 'https://deerdawn.com';
const REPLY_TO = process.env.CONCIERGE_REPLY_TO || 'john@deerdawn.com';
// Optional. When unset the email asks them to reply with times instead of
// linking a calendar — the draft allows either, and an empty href would be worse
// than the fallback sentence.
const BOOKING_URL = process.env.CONCIERGE_BOOKING_URL || '';

const SENT_EVENT = 'concierge_recovery_email_sent';
const EMAIL_TYPE = 'concierge_recovery';

// Far enough past the activation follow-up's 20-44h window that the two cannot
// land in the same day saying different things, without making the hottest
// segment in the funnel wait a week to hear from anyone.
const MIN_AGE_DAYS = Number(process.env.CONCIERGE_RECOVERY_MIN_AGE_DAYS) || 3;
const MAX_PER_RUN = Number(process.env.CONCIERGE_RECOVERY_MAX_PER_RUN) || 100;

const VARIANT_STUCK = 'setup_stuck';
const VARIANT_BLIND_SPOT = 'blind_spot';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
  ));
}

const SUBJECTS = {
  [VARIANT_STUCK]: 'I can see where DeerDawn’s setup lost you',
  [VARIANT_BLIND_SPOT]: 'Has DeerDawn actually been working for you?',
};

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

// Plain-English name for the rung the account reached. Observed fact — safe to
// state. Deliberately vague where the rung is ambiguous: "the connect step"
// covers both the local and hosted routes and is the draft's own example of a
// line that cannot be wrong.
const STEP_PHRASE = {
  0: 'the very first step',
  1: 'the onboarding page',
  2: 'the setup page',
  3: 'picking which tool to set up',
  4: 'copying the config',
  5: 'the connect step',
  6: 'signing in to authorize the connection',
  7: 'the moment right after connecting',
  // 8 and 9 are the two RUNTIME rungs, so anyone who reaches either is routed to
  // the blind-spot variant, which never interpolates this line (and the dry-run
  // printer skips it too). Kept honest anyway, because the map is keyed by rank
  // NUMBER and a wrong entry here is invisible until the day it is rendered:
  // rung 8 is a handshake with no tool call behind it, so "the connect step" is
  // still true; rung 9 means the model really did call us, and saying they
  // stopped at the connect step would be false. Rung 10 (activation) has no
  // entry because an activated account is excluded from this audience by the
  // NOT EXISTS in findRecipients.
  8: 'the connect step',
  9: 'a session that ran without ever producing a brief',
};

// The draft's table, keyed by what the event stream can actually distinguish.
// These are hypotheses to check on the call, never verdicts — the copy frames
// them as guesses and this map is why it can afford to.
const CLAUDE_CODE_TOOLS = ['claude_code', 'claude-code', 'claudecode'];
const CODEX_TOOLS = ['codex', 'codex_cli', 'openai_codex'];
const RESTART_TOOLS = ['cursor', 'claude_desktop', 'claude-desktop', 'windsurf', 'vscode', 'vs_code', 'zed'];

function normalizeTool(tool) {
  return String(tool || '').trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Derive one person's diagnosis from their event rows.
 *
 * Returns { rank, lastEvent, tool, stepPhrase, hypothesis, confident, needsReview }.
 * `hypothesis` is null whenever the events do not support a specific cause;
 * the caller then omits the guess sentence rather than inventing one.
 * `needsReview` marks the cases the draft says a human must read before sending
 * — currently oauth_consent_failed, whose cause is in the failure reason and
 * cannot be guessed from the event name.
 */
function deriveDiagnosis(events = []) {
  const seen = new Map();
  let rank = -1;
  let lastEvent = null;
  let lastAt = null;

  for (const e of events) {
    const r = segments.LADDER_RANK[e.event_name];
    if (r === undefined) continue;
    if (!seen.has(e.event_name)) seen.set(e.event_name, []);
    seen.get(e.event_name).push(e);
    const at = e.created_at ? new Date(e.created_at).getTime() : 0;
    // Highest rung wins; ties broken by recency so `tool` reflects the last
    // attempt rather than the first.
    if (r > rank || (r === rank && at >= (lastAt || 0))) {
      rank = r;
      lastEvent = e.event_name;
      lastAt = at;
    }
  }

  const rowsFor = (name) => seen.get(name) || [];
  const metaOf = (row) => (row && row.metadata) || {};
  // The tool the person was actually working with, newest declaration first.
  const toolRows = [...rowsFor('mcp_config_copied'), ...rowsFor('setup_path_changed'), ...rowsFor('setup_path_selected')];
  const tool = normalizeTool(
    toolRows.map((r) => metaOf(r).tool).find((t) => t),
  );

  const out = {
    rank,
    lastEvent,
    tool: tool || null,
    stepPhrase: STEP_PHRASE[rank] || 'the connect step',
    hypothesis: null,
    confident: false,
    needsReview: false,
  };

  if (rank < 0) return out;

  // oauth_consent_failed carries its reason in metadata. The draft is explicit
  // that this one is read by a human, not guessed at.
  if (rowsFor('oauth_consent_failed').length && rank <= 6) {
    out.needsReview = true;
    out.reviewReason = metaOf(rowsFor('oauth_consent_failed').slice(-1)[0]).reason || 'unknown';
    return out;
  }

  if (lastEvent === 'onboarding_connection_detected') {
    out.hypothesis = 'you’re connected — it just never got asked for a brief';
    out.confident = true;
    return out;
  }

  if (rowsFor('oauth_consent_signin_required').length && rank <= 6) {
    out.hypothesis = 'the authorize step bounced you to sign-in and lost the thread';
    out.confident = true;
    return out;
  }

  // has_request = 0 means the tool sent them to the consent screen with no
  // authorization request attached: a broken hand-off, not a change of mind.
  const brokenHandoff = rowsFor('oauth_consent_viewed').some((r) => Number(metaOf(r).has_request) === 0);
  if (brokenHandoff && rank <= 6) {
    out.hypothesis = 'your tool sent you to the sign-in page without the actual request attached';
    out.confident = true;
    return out;
  }

  if (lastEvent === 'mcp_config_copied') {
    if (CLAUDE_CODE_TOOLS.includes(tool)) {
      out.hypothesis = 'the JSON config never applies to Claude Code — it registers servers through its own command';
      out.confident = true;
    } else if (CODEX_TOOLS.includes(tool)) {
      out.hypothesis = 'Codex needs two CLI commands rather than a pasted config';
      out.confident = true;
    } else if (RESTART_TOOLS.includes(tool)) {
      out.hypothesis = 'the config looks right — the tool almost certainly needs a restart before it loads it';
      out.confident = true;
    }
    // Unknown tool: no guess. "Copying the config" is still stated as the step.
    return out;
  }

  // Hunting through the picker for instructions that looked right.
  if (rank === 3 && rowsFor('setup_path_changed').length >= 1) {
    out.hypothesis = 'you were sent instructions that didn’t match your setup';
    out.confident = true;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function greeting(firstName) {
  // No name column exists on `users`; PostHog holds the names, this process does
  // not. Rather than guess one out of an email local-part and open with "Hi
  // Jsmith22", the default is a nameless greeting and the CLI's --name flag lets
  // the human who knows the name supply it for a one-at-a-time send.
  return firstName ? `Hi ${esc(firstName)},` : 'Hi,';
}

function bookingSentence() {
  return BOOKING_URL
    ? `<a href="${esc(BOOKING_URL)}" style="color:#10B981;">Grab any slot here</a>, or just reply with a screenshot of what you&rsquo;re seeing and I&rsquo;ll tell you the fix.`
    : 'Just reply with a couple of times that suit you — or send me a screenshot of what you&rsquo;re seeing and I&rsquo;ll tell you the fix instead.';
}

function shell(inner, unsubUrl) {
  return `<!doctype html><html><body style="margin:0;background:#07111d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#e5e7eb;">
${inner}
    <hr style="margin:24px 0 0;border:none;border-top:1px solid #1e2b3d;" />
    <p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">
      You&rsquo;re receiving this because you created a DeerDawn account at ${esc(SITE_URL.replace(/^https?:\/\//, ''))}.<br />
      <a href="${esc(unsubUrl)}" style="color:#6b7280;">Unsubscribe</a>
    </p>
  </div>
</body></html>`;
}

// A-3, from docs/growth/outreach/a3-stuck-concierge.md.
// Note there is NO offer, no price and no checkout link anywhere in this email,
// by design: nothing is sold to someone the product has never worked for.
function renderStuckHtml({ diagnosis, firstName, unsubUrl }) {
  const guess = diagnosis.hypothesis
    ? `<p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">If I had to guess: ${esc(diagnosis.hypothesis)}. That&rsquo;s a setup problem, not something you did wrong &mdash; most people who get that far hit the same wall.</p>`
    : '<p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">That&rsquo;s a setup problem, not something you did wrong &mdash; most people who get that far hit the same wall.</p>';

  return shell(`    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">${greeting(firstName)}</p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      DeerDawn records which setup step each account reaches &mdash; that&rsquo;s how I find the broken ones &mdash; and yours stopped at ${esc(diagnosis.stepPhrase)}.
    </p>
${guess}
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Fifteen minutes on a call and I&rsquo;ll get your first brief working. ${bookingSentence()}
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      I&rsquo;m not selling you anything here. It doesn&rsquo;t work for you yet, so there&rsquo;s nothing to sell.
    </p>
    <p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">John</p>`, unsubUrl);
}

// The blind-spot variant. This one asks rather than tells, because the only
// honest thing the event stream supports for this cohort is that WE could not
// see. Same no-pitch rule.
function renderBlindSpotHtml({ firstName, unsubUrl }) {
  return shell(`    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">${greeting(firstName)}</p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      You connected DeerDawn and your tool did start a session with it. What our server never did was record whether a brief actually came back &mdash; a gap on our side that I only just closed.
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Which means I genuinely can&rsquo;t tell from here whether DeerDawn has been working for you or quietly doing nothing. So rather than guess: has it?
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      If it&rsquo;s been fine, ignore this and sorry for the noise. If it hasn&rsquo;t, reply and tell me where it stops &mdash; or take fifteen minutes with me and I&rsquo;ll get it working. ${bookingSentence()}
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Nothing to sell you here. I&rsquo;d rather know than guess.
    </p>
    <p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">John</p>`, unsubUrl);
}

function renderForVariant(variant, opts) {
  return variant === VARIANT_BLIND_SPOT ? renderBlindSpotHtml(opts) : renderStuckHtml(opts);
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

// Stuck = tried to connect, has no activation on record, has not already had
// this email, has not opted out. The unsubscribe flag is the same one the weekly
// digest and the activation follow-up honour: one opt-out stops all marketing.
async function findRecipients({ limit = MAX_PER_RUN, minAgeDays = MIN_AGE_DAYS, onlyEmail } = {}) {
  const attempted = [...segments.SETUP_ATTEMPT_EVENTS, ...segments.RUNTIME_EVENTS];
  const res = await db.query(
    `SELECT u.user_id, u.org_id, u.email, u.created_at
       FROM users u
      WHERE u.email IS NOT NULL
        AND POSITION($4 IN lower(u.email)) = 0
        AND COALESCE(u.weekly_digest_unsubscribed, false) = false
        AND u.created_at <= NOW() - ($5 || ' days')::interval
        AND ($7::text IS NULL OR lower(u.email) = lower($7))
        AND EXISTS (
            SELECT 1 FROM product_events a
             WHERE a.event_name = ANY($1)
               AND (a.user_id = u.user_id OR a.org_id = u.org_id)
        )
        AND NOT EXISTS (
            SELECT 1 FROM product_events d
             WHERE d.event_name = ANY($6)
               AND (d.user_id = u.user_id OR d.org_id = u.org_id)
        )
        AND NOT EXISTS (
            SELECT 1 FROM product_events s
             WHERE s.event_name = $2 AND s.user_id = u.user_id
        )
      ORDER BY u.created_at ASC
      LIMIT $3`,
    [attempted, SENT_EVENT, limit, segments.TEST_EMAIL_MARKER, String(minAgeDays),
      segments.ACTIVATION_EVENTS, onlyEmail || null],
    'org-system',
  ).catch((err) => {
    console.warn(`[EMAIL] concierge recovery recipient query failed: ${err.message}`);
    return { rows: [] };
  });
  return res.rows || [];
}

// One round trip for the whole cohort's ladder events rather than N+1 — these
// are read to decide what to SAY to each person, so they are fetched together
// and walked in JS where the rules are readable.
async function loadLadderEvents(userIds = [], orgIds = []) {
  if (!userIds.length) return new Map();
  const res = await db.query(
    `SELECT user_id, org_id, event_name, metadata, created_at
       FROM product_events
      WHERE event_name = ANY($1)
        AND (user_id = ANY($2) OR (org_id = ANY($3) AND org_id IS NOT NULL))
      ORDER BY created_at ASC`,
    [segments.LADDER_EVENTS, userIds, orgIds.filter(Boolean)],
    'org-system',
  ).catch((err) => {
    console.warn(`[EMAIL] concierge ladder query failed: ${err.message}`);
    return { rows: [] };
  });

  const byUser = new Map(userIds.map((id) => [id, []]));
  const orgToUsers = new Map();
  for (let i = 0; i < userIds.length; i += 1) {
    const org = orgIds[i];
    if (!org) continue;
    if (!orgToUsers.has(org)) orgToUsers.set(org, []);
    orgToUsers.get(org).push(userIds[i]);
  }

  for (const row of res.rows || []) {
    if (row.user_id && byUser.has(row.user_id)) {
      byUser.get(row.user_id).push(row);
      continue;
    }
    // Org-attributed events (key-authed MCP calls with no user actor) belong to
    // every user in that org for the purpose of "did this account get anywhere".
    for (const uid of orgToUsers.get(row.org_id) || []) byUser.get(uid).push(row);
  }
  return byUser;
}

/** Recipients with their variant and diagnosis resolved — what the dry run prints. */
async function buildAudience({ limit, minAgeDays, onlyEmail } = {}) {
  const recipients = await findRecipients({ limit, minAgeDays, onlyEmail });
  if (!recipients.length) return [];

  const events = await loadLadderEvents(
    recipients.map((r) => r.user_id),
    recipients.map((r) => r.org_id),
  );

  return recipients.map((r) => {
    const rows = events.get(r.user_id) || [];
    const diagnosis = deriveDiagnosis(rows);
    // A running MCP session with no activation on record is the C-1a blind spot,
    // not a person the setup lost. Different email.
    const ranRuntime = rows.some((e) => segments.RUNTIME_EVENTS.includes(e.event_name));
    return {
      ...r,
      variant: ranRuntime ? VARIANT_BLIND_SPOT : VARIANT_STUCK,
      diagnosis,
    };
  });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Send the concierge recovery campaign.
 *
 * `apply` defaults to FALSE. The dry run is what makes the derived diagnosis
 * reviewable before a stranger is told what went wrong on their machine — the
 * draft's stated failure mode is a diagnosis that turns out to be wrong on the
 * call, and a human reading the list is the control for that.
 *
 * Recipients whose diagnosis is flagged `needsReview` are held back from --apply
 * unless the caller passes an explicit `diagnosisOverride`, because the only
 * honest line for them lives in a failure reason a person has to read.
 */
async function sendConciergeRecoveryEmails({
  apply = false, limit, minAgeDays, onlyEmail, firstName, diagnosisOverride,
} = {}) {
  const audience = await buildAudience({ limit, minAgeDays, onlyEmail });

  const prepared = audience.map((r) => {
    const diagnosis = diagnosisOverride
      ? { ...r.diagnosis, hypothesis: diagnosisOverride, confident: true, needsReview: false, overridden: true }
      : r.diagnosis;
    return { ...r, diagnosis, held: diagnosis.needsReview };
  });

  if (!apply) {
    return { dryRun: true, sent: 0, total: prepared.length, recipients: prepared };
  }
  if (!process.env.RESEND_API_KEY) {
    console.log('[EMAIL] Concierge recovery skipped — RESEND_API_KEY not set');
    return { sent: 0, total: prepared.length, skipped: true, recipients: prepared };
  }

  let sent = 0;
  let held = 0;
  for (const r of prepared) {
    if (r.held) {
      held += 1;
      console.log(`[EMAIL] concierge held for review: ${r.email} (oauth_consent_failed reason=${r.diagnosis.reviewReason})`);
      continue;
    }
    try {
      const result = await resendClient.sendEmail({
        to: r.email,
        subject: SUBJECTS[r.variant],
        html: renderForVariant(r.variant, {
          diagnosis: r.diagnosis,
          firstName,
          unsubUrl: unsubscribeUrl(r.user_id),
        }),
        replyTo: REPLY_TO,
        emailType: EMAIL_TYPE,
      });
      if (result.ok) {
        sent += 1;
        // The sent-marker is what makes this once-per-person even across re-runs.
        await productEvents.recordProductEvent(
          { type: 'user', id: r.user_id, org_id: r.org_id },
          {
            event_name: SENT_EVENT,
            source: 'api',
            surface: 'concierge_recovery',
            metadata: {
              channel: 'email',
              campaign: 'a3_concierge',
              variant: r.variant,
              // Recorded so a reply can be read against what we actually claimed.
              last_event: r.diagnosis.lastEvent,
              hypothesis_given: Boolean(r.diagnosis.hypothesis),
            },
          },
        ).catch((err) => console.warn(`[EMAIL] concierge sent-marker failed for ${r.user_id}: ${err.message}`));
      }
    } catch (err) {
      console.warn(`[EMAIL] concierge recovery failed for ${r.user_id}: ${err.message}`);
    }
  }
  console.log(`[EMAIL] Concierge recovery sent ${sent}/${prepared.length}${held ? ` (${held} held for review)` : ''}`);
  return { sent, total: prepared.length, held };
}

module.exports = {
  sendConciergeRecoveryEmails,
  buildAudience,
  findRecipients,
  loadLadderEvents,
  deriveDiagnosis,
  renderStuckHtml,
  renderBlindSpotHtml,
  renderForVariant,
  SUBJECTS,
  SENT_EVENT,
  EMAIL_TYPE,
  VARIANT_STUCK,
  VARIANT_BLIND_SPOT,
  MIN_AGE_DAYS,
};
