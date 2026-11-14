'use strict';

// Day-two catch-up — the delta layer on top of the current-state brief.
//
// The wow of a return session lives in the DELTA, not the state: "last session
// you shipped X; Y is still open" is a chief of staff, while re-dumping the
// whole brief is a filing cabinet. This service turns each real session start
// (start_session with mark_session) into a durable row, computes what changed
// since the PREVIOUS session from the per-item timestamps the slots already
// carry (shipped_at / decided_at / added_at), and emits the activation events
// built on top of that (session_started, catchup_delivered, day_two_wow,
// second_tool_connected).
//
// Honesty rules (they ARE the product):
//   - empty slots stay empty — never backfill or pad a delta
//   - the timestamp filter is also the stale-write-back guard: if nothing was
//     written after the previous session started, the delta is empty
//   - gap phrasing is computed here, once, so every client says time identically
//
// Everything is best-effort: a catch-up failure must never break the brief.

const db = require('../config/db');
const store = require('../store/contextSyncStore');
const workspace = require('./workspaceService');
const { detectContradictions, renderContradictions } = require('./contradictionDetector');
const productEvents = require('./productEventsService');
const connectionIdentity = require('./connectionIdentity');
const { trackRedditActivation } = require('./reddit');
const { trackGoogleAdsSetup } = require('./googleAds');
const { isInternalIdentity } = require('./internalAccounts');
const { receiptToolLabel } = require('../../../../packages/shared-context/src/briefReceipt.js');

// Value events that count as "the user reached the product working" — used as
// the anchor for day_two_wow's ≥6h separation. session_started is the canonical
// going-forward signal; the others cover history from before it existed.
// connection_established belongs here even though it is not activation: for a
// brand-new account it is the ONLY signal the first session leaves, so without it
// day_two_wow can never anchor early enough to fire on the return session.
const VALUE_EVENTS = ['session_started', 'mcp_start_session_succeeded', 'context_delivered', 'first_sync_completed', 'connection_established'];
const DAY_TWO_MIN_GAP_HOURS = 6;
const DAY_TWO_WINDOW_DAYS = 7;
// Two people inside one week is a team using the thing together. Wider and a
// colleague who tried it last month counts; narrower and a team that works in
// alternating shifts never registers.
const TEAM_ACTIVATION_WINDOW_DAYS = 7;
// A ROW WITH NO PERSON ON IT IS NOBODY'S ONCE THERE IS MORE THAN ONE PERSON.
//
// Legacy key-authed events (user_id NULL) used to be folded into whoever asked,
// by org, "so an established solo account isn't reset". In a workspace that has
// held two or more people that credited them to every member, so a co-owner who
// had connected nothing never fired their own first sync or connection. The fold
// now applies only while the workspace has held at most one person, where there
// is only one person the row could be. Same rule an unmatched git author follows:
// nobody, never the one who happens to be asking.
//
// SQL fragment over product_events (alias-free); `orgParam` is the placeholder of
// the workspace key. workspace_members carries no RLS policy.
function unownedEventsAreMine(orgParam) {
  return `(org_id = ${orgParam} AND user_id IS NULL
            AND (SELECT COUNT(*) FROM workspace_members wm WHERE wm.owner_key = ${orgParam}) <= 1)`;
}

const TEAM_ACTIVATION_MIN_MEMBERS = 2;
// Under this gap with nothing new recorded, say nothing — a recap of a 90-minute
// old session reads like a goldfish repeating itself.
const RECAP_SUPPRESS_MS = 2 * 60 * 60 * 1000;
const MAX_ITEMS_PER_SLOT = 3;
// A FIRST session has no "since last session" — and on a shared project that is
// exactly the session the team delta exists for, so treating a null cutoff as
// "nothing to show" silenced the one brief that had to speak (and with it
// team_context_received, the team activation event, which can only fire from
// this path). The honest bound for somebody with no history here is a recent
// window of OTHER PEOPLE's work: wide enough that a project which went quiet for
// a fortnight before the new teammate arrived still hands them something, narrow
// enough that they are not read the project's whole life on day one. The
// per-slot cap (MAX_ITEMS_PER_SLOT, newest first) does the rest of the bounding,
// so this only decides how far back "recent" reaches.
const TEAM_DELTA_FIRST_SESSION_WINDOW_MS = 30 * 86400000;
// Surfaces that don't identify a real tool — never let these create or count as
// a "distinct tool" for second_tool_connected.
const NON_IDENTIFYING_SURFACES = new Set(['', 'unknown', 'unknown_web']);

function getActorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

// Same fallback as productEventsService.buildActorFields: key-authed MCP actors
// attribute to the key's owning user so per-user metrics don't collapse to org.
function actorUserId(actor) {
  const a = actor || {};
  return a.type === 'user' ? a.id : (a.owner_id || null);
}

function clip(text, max = 140) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toMs(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

// One phrasing of elapsed time for every surface. Coarse on purpose — "yesterday"
// lands, "26.3 hours ago" doesn't.
function humanizeGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const days = Math.floor(ms / 86400000);
  if (days === 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

// Items written back strictly AFTER the previous session started. Slot arrays
// are append-ordered, so slice(-N).reverse() yields newest-first.
function buildSinceLastSession(context, lastSessionAt) {
  const empty = { shipped: [], decided: [], landmines: [] };
  const cutoff = toMs(lastSessionAt);
  if (!cutoff || !context) return empty;
  const after = (ts) => {
    const t = toMs(ts);
    return t !== null && t > cutoff;
  };
  const summaries = (entries, tsField) => (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.summary && after(e[tsField]))
    .slice(-MAX_ITEMS_PER_SLOT)
    .reverse()
    .map((e) => clip(e.summary));
  return {
    shipped: summaries(context.shipped, 'shipped_at'),
    decided: summaries(context.recent_decisions, 'decided_at'),
    landmines: summaries(context.landmines, 'added_at'),
  };
}

/**
 * The same filter as buildSinceLastSession, keeping who wrote each entry.
 *
 * A SEPARATE function rather than an extra key on the object above, because that
 * shape is a published contract: the MCP tools, the dashboard and the emitted
 * events all read since_last_session, and a test asserts it deep-equals exactly
 * three arrays. Widening it in place broke that test immediately — which is the
 * cheap version of breaking every consumer later.
 */
function buildAttributedEntries(context, lastSessionAt) {
  const empty = { shipped: [], decided: [], landmines: [] };
  const cutoff = toMs(lastSessionAt);
  if (!cutoff || !context) return empty;
  const after = (ts) => {
    const t = toMs(ts);
    return t !== null && t > cutoff;
  };
  const attributed = (entries, tsField) => (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.summary && after(e[tsField]))
    .slice(-MAX_ITEMS_PER_SLOT)
    .reverse()
    .map((e) => ({
      summary: clip(e.summary),
      at: e[tsField] || null,
      // null is a real answer here and renders as "unattributed" — never as the
      // reader. Anything written before per-item attribution existed has no
      // author, and quietly implying one would be worse than admitting none.
      contributed_by: e.contributed_by || null,
      confirmed_by: e.confirmed_by || null,
    }));
  return {
    shipped: attributed(context.shipped, 'shipped_at'),
    decided: attributed(context.recent_decisions, 'decided_at'),
    landmines: attributed(context.landmines, 'added_at'),
  };
}

/**
 * The cutoff the TEAM delta is filtered against.
 *
 * Their own last session when they have one — a teammate's brief should not
 * re-read them work they were already shown. A bounded recent window when they
 * do not, which is the first session on a shared project: null there means "no
 * prior visit", not "nothing happened", and reading it as the latter is what
 * silenced the new teammate's first brief entirely.
 */
function teamDeltaCutoff(lastSessionAt) {
  if (toMs(lastSessionAt) !== null) return lastSessionAt;
  return new Date(Date.now() - TEAM_DELTA_FIRST_SESSION_WINDOW_MS).toISOString();
}

/**
 * Turn the attributed entries into "who did what while you were gone", for the
 * reader's own eyes excluded.
 *
 * THIS IS THE WHOLE TEAM PRODUCT. A solo brief is a diary: skipping a day costs
 * nothing, because nothing happened while you were away. A team brief is a
 * message from a colleague, so skipping a day means missing something — which is
 * why a shared workspace keeps a habit that a personal one does not.
 *
 * Returns null on a solo workspace, where every entry is the reader's own and
 * naming them would be noise.
 */
function buildTeamDelta(entries, viewerId, names = new Map()) {
  if (!entries) return null;
  const rows = [];
  for (const [kind, list] of Object.entries(entries)) {
    for (const entry of list) {
      const author = entry.contributed_by;
      if (!author || author === viewerId) continue;
      rows.push({
        kind: kind === 'decided' ? 'decided' : kind === 'landmines' ? 'landmine' : 'shipped',
        summary: entry.summary,
        at: entry.at,
        author,
        author_name: names.get(author) || null,
      });
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0));
  const authors = [...new Set(rows.map((r) => r.author))];
  return { rows, author_count: authors.length };
}

/** Prefer a person's name over an opaque id; fall back to the id, never to nothing. */
function displayAuthor(row) {
  return row.author_name || row.author;
}

// The slots that carry an author. Only these can answer "has this reader
// written here", and they are the same ones buildAttributedEntries reads.
const ATTRIBUTED_SLOTS = ['recent_decisions', 'shipped', 'landmines', 'debugging_notes', 'hot_paths'];

/**
 * Has this reader been here before, whatever the session log says?
 *
 * A first recorded SESSION is not a first visit. The author created the project
 * and filled it — often through a surface that never wrote a session row — and a
 * teammate may have contributed from another one. Both answers are already in
 * memory: owner_user_id on the project row, contributed_by on the entries. No
 * query, so a solo account pays nothing for this.
 *
 * Identities rather than one id, because a key-authed actor's person id is the
 * key's — the same rule every other attribution match here follows.
 */
function viewerHasStakeIn(project, identities = []) {
  const mine = new Set((identities || []).filter(Boolean));
  if (!mine.size) return false;
  if (project?.owner_user_id && mine.has(project.owner_user_id)) return true;
  const context = project?.context || {};
  return ATTRIBUTED_SLOTS.some((slot) => (Array.isArray(context[slot]) ? context[slot] : [])
    .some((entry) => entry?.contributed_by && mine.has(entry.contributed_by)));
}

// A task confirmed finished (finish_task / task_completed leave current_task in
// place with task_progress:'completed') is history, not an open thread. The
// catch-up used to read current_task alone and so opened the next session with
// "Still open: X … Resume: Pick up X" over work the person had just closed.
function taskIsOpen(context) {
  return Boolean(context?.current_task) && context?.task_progress !== 'completed';
}

// One deterministic sentence the AI may voice — a suggestion, not a command.
// next_action is the exact cursor when present; the open task is the fallback.
// Neither applies once the task is finished: next_action is the cursor INSIDE
// that task.
function buildResumeHint(context) {
  if (!context) return null;
  const finished = context.task_progress === 'completed';
  if (context.next_action && !finished) return clip(`Continue with: ${context.next_action}`, 160);
  if (taskIsOpen(context)) {
    const status = context.current_status ? ` (${clip(context.current_status, 60)})` : '';
    return clip(`Pick up ${context.current_task}${status}`, 160);
  }
  const question = (context.open_questions || [])[0];
  return question ? clip(`Open question: ${question}`, 160) : null;
}

function countDelta(since) {
  return since.shipped.length + since.decided.length + since.landmines.length;
}

/**
 * The open task, when it was SET after the previous session started.
 *
 * Not one of since_last_session's three arrays, on purpose: that shape is the
 * published contract (see buildAttributedEntries). current_task_set_at is
 * stamped by the server whenever the task text changes, so this is the same
 * timestamp filter the slots use, applied to the one field that is not a list.
 * A finished task is history, not news.
 */
function taskSetSinceLastSession(context, lastSessionAt) {
  const cutoff = toMs(lastSessionAt);
  const setAt = toMs(context?.current_task_set_at);
  if (cutoff === null || setAt === null || setAt <= cutoff) return null;
  if (!taskIsOpen(context)) return null;
  return clip(context.current_task, 100);
}

/**
 * Where and what the previous session was, for the catch-up — a NEW field beside
 * since_last_session rather than a key inside it (that shape is pinned).
 * null when there was no previous session. `tool_label` is null for a load that
 * named no identifiable tool ('unknown_web', or a row from before loads carried
 * one): never a guess.
 */
function buildPreviousLoad(load, context) {
  if (!load || toMs(load.last_session_at) === null) return null;
  const tool = load.last_tool || null;
  return {
    at: load.last_session_at,
    tool,
    tool_label: receiptToolLabel(tool),
    task_set_since: taskSetSinceLastSession(context, load.last_session_at),
  };
}

// Compact, labeled data block for the agent — the instruction layer (not this
// text) governs how the AI voices it. Returns null when there is nothing worth
// saying (first session ever, or a <2h return with no changes).
function renderCatchupText({ projectName, load, gapMs, gapHuman, since, resumeHint, context, teamDelta, contradictionText, viewerIsNewHere = true, previousLoad = null }) {
  if (!load) return null;

  // A FIRST session on a shared project is not "nothing to say" — it is the one
  // session where the reader has no idea what anybody has been doing, and the
  // only one on which team_context_received can ever fire. A solo first session
  // still says nothing (there is no delta and no colleague), which is why the
  // gate is the team delta rather than the session number.
  if (load.session_number <= 1 || !gapHuman) {
    if (!teamDelta?.rows?.length) return null;
    // "You have no history here" is a claim about the READER, and a first
    // recorded SESSION is not a first visit. The project's own author reaches
    // this branch the first time a session row is written for them, and so does
    // anybody whose name is already on something here — #510 made this block
    // reachable on the hosted connector and handed both of them a sentence they
    // can see is false. Only the clause goes: the rest of the block is the
    // teammates' work, which is worth reading either way.
    return renderTeamBlock({
      header: viewerIsNewHere
        ? `First session on ${projectName} — you have no history here, so this is what your teammates have recorded.`
        : `What your teammates have recorded on ${projectName}.`,
      teamDelta,
      ownLines: [],
      firstSession: true,
      context,
      contradictionText,
      resumeHint,
    });
  }

  // A task set since the last session is news even when no slot moved: saying
  // "Nothing new recorded since then" over it would be false.
  const newTask = previousLoad?.task_set_since || null;
  const hasDelta = countDelta(since) > 0 || Boolean(newTask);
  if (!hasDelta && Number.isFinite(gapMs) && gapMs < RECAP_SUPPRESS_MS) return null;

  // Ambient accumulation, once it exists: a fact, not a nag. Suppressed while
  // the history is too young to be worth a word.
  const firstMs = toMs(load.first_session_at);
  const monthsOld = firstMs ? (Date.now() - firstMs) / (28 * 86400000) : 0;
  const sinceMonth = monthsOld >= 1
    ? ` · context since ${new Date(firstMs).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`
    : '';
  // Where the last session happened, when the load named a tool we can name:
  // "last session yesterday in ChatGPT" is the cross-tool moment, said as a fact.
  const where = previousLoad?.tool_label ? ` in ${previousLoad.tool_label}` : '';
  const header = `Session ${load.session_number} on ${projectName}${sinceMonth} — last session ${gapHuman}${where}.`;

  if (!hasDelta) {
    const task = context?.current_task ? clip(context.current_task, 100) : null;
    const status = context?.current_status ? ` (${clip(context.current_status, 80)})` : '';
    const quiet = task && taskIsOpen(context)
      ? `${header} Nothing new recorded since then — ${task}${status} is where you left it.`
      : task
        ? `${header} Nothing new recorded since then — ${task} was finished last time; no task is open.`
        : `${header} Nothing new recorded since then.`;
    // A standing disagreement does not go away because nobody wrote this week —
    // it is arguably MORE worth saying then, since nothing has resolved it.
    return contradictionText ? `${quiet}\n${contradictionText}` : quiet;
  }

  const mine = new Set((teamDelta?.rows || []).map((r) => r.summary));
  const ownLines = [];
  for (const s of since.shipped) if (!mine.has(s)) ownLines.push(`  shipped: ${s}`);
  for (const d of since.decided) if (!mine.has(d)) ownLines.push(`  decided: ${d}`);
  for (const l of since.landmines) if (!mine.has(l)) ownLines.push(`  landmine: ${l}`);
  if (newTask) ownLines.push(`  new task: ${newTask}`);
  return renderTeamBlock({ header, teamDelta, ownLines, context, contradictionText, resumeHint, taskAlreadyShown: Boolean(newTask) });
}

/**
 * The shared body: what other people recorded, then what you recorded, then the
 * standing state. Split out so a first session and a return session cannot
 * drift into describing a teammate's work two different ways.
 *
 * `ownLines` is empty on a first session, deliberately — a person with no
 * history here has nothing of their own in the window, and inventing a "your
 * own" heading over an empty list would read as data loss.
 */
function renderTeamBlock({ header, teamDelta, ownLines, firstSession = false, context, contradictionText, resumeHint, taskAlreadyShown = false }) {
  const lines = [header];

  // On a shared workspace, lead with what OTHER PEOPLE did. It is the reason
  // this brief is worth reading at all, and burying it under your own history
  // would be the wrong way round.
  if (teamDelta?.rows?.length) {
    const people = teamDelta.author_count === 1 ? 'a teammate' : `${teamDelta.author_count} teammates`;
    // "While you were away" presumes a previous visit; on a first session there
    // was no away to be while.
    lines.push(firstSession
      ? `Recently, ${people} recorded:`
      : `While you were away, ${people} recorded:`);
    for (const row of teamDelta.rows.slice(0, MAX_ITEMS_PER_SLOT)) {
      lines.push(`  ${displayAuthor(row)} — ${row.kind}: ${row.summary}`);
    }
    if (!firstSession) lines.push('Your own since last session:');
  } else {
    lines.push('Since last session:');
  }
  lines.push(...ownLines);

  // A task that is itself the news ("new task: X" above) is not also "still open".
  const openTask = taskIsOpen(context) && !taskAlreadyShown
    ? `Still open: ${clip(context.current_task, 100)}${context.current_status ? ` — ${clip(context.current_status, 80)}` : ''}`
    : null;
  if (openTask) lines.push(openTask);
  if (contradictionText) lines.push(contradictionText);
  if (resumeHint) lines.push(`Resume: ${resumeHint}`);
  return lines.join('\n');
}

// second_tool_connected — THE retention transition: fires once, when the account
// first spans two distinct identifying tools. Callable from any surface-bearing
// entry point (session mark, remote MCP initialize); idempotent via the emitted
// event itself.
//
// Surface source: ONLY source='mcp' events, whose surface is the tool's real
// self-reported identity (remote: initialize clientInfo; local stdio:
// DEERDAWN_SURFACE_ID / clientInfo fallback). context_sync events are excluded
// because their surface is a rendering PROFILE (the remote path renders every
// web tool as 'claude_web'), which would otherwise pollute the tool set and both
// false-fire and permanently block this metric for ChatGPT users.
//
// Order-independent: the passed surface is unioned into the observed set, so it
// fires whether or not this session's own mcp event has landed yet. Best-effort
// query on the isolated breaker — never blocks a session start or handshake.
async function maybeEmitSecondToolConnected(actor, surface) {
  if (!surface || NON_IDENTIFYING_SURFACES.has(surface)) return false;
  const orgId = workspace.defaultOwnerKey(actor) || null;
  const userId = actorUserId(actor);
  if (!orgId && !userId) return false;
  const result = await db.queryBestEffort(
    `SELECT
       ARRAY(
         SELECT DISTINCT surface FROM product_events
          WHERE (org_id = $1 OR user_id = $2)
            AND source = 'mcp'
            AND surface IS NOT NULL
            AND surface NOT IN ('', 'unknown', 'unknown_web')
       ) AS surfaces,
       EXISTS (
         SELECT 1 FROM product_events
          WHERE (org_id = $1 OR user_id = $2) AND event_name = 'second_tool_connected'
       ) AS already`,
    [orgId, userId],
    orgId || 'org-system'
  );
  const row = result.rows?.[0];
  if (!row || row.already) return false;
  const distinct = new Set((row.surfaces || []).filter((s) => s && !NON_IDENTIFYING_SURFACES.has(s)));
  const firstTool = [...distinct].find((s) => s !== surface) || null;
  distinct.add(surface);
  // Fire when the account first spans two identifying tools.
  if (distinct.size < 2) return false;
  await productEvents.recordProductEvent(actor, {
    event_name: 'second_tool_connected',
    source: 'context_sync',
    surface,
    metadata: { first_tool: firstTool, second_tool: surface },
  });
  return true;
}

// day_two_wow — THE activation event: the first catch-up delivered ≥6h after the
// user first reached value, within 7 days of THAT user's signup. Emitted at most
// once per user; the emitted event is its own idempotence marker.
//
// Strictly per-USER, not per-org: signup_at is this user's users.created_at, so
// first_value_at and the idempotence check must be this user's too. A shared org
// scope would fire instantly for a newly-invited member (against a veteran
// teammate's months-old first value) and cap the metric at once-per-org. Legacy
// key-authed events that predate per-user attribution (user_id NULL) are folded
// in by org so an established solo account isn't reset.
async function maybeEmitDayTwoWow(actor, surface, projectId) {
  const userId = actorUserId(actor);
  if (!userId) return false;
  const orgId = workspace.defaultOwnerKey(actor) || null;
  const result = await db.queryBestEffort(
    `SELECT
       (SELECT u.created_at FROM users u WHERE u.user_id = $1) AS signup_at,
       (SELECT MIN(e.created_at) FROM product_events e
         WHERE (e.user_id = $1 OR (e.org_id = $2 AND e.user_id IS NULL
                AND (SELECT COUNT(*) FROM workspace_members wm WHERE wm.owner_key = $2) <= 1))
           AND e.event_name = ANY($3)) AS first_value_at,
       EXISTS (
         SELECT 1 FROM product_events d
          WHERE d.user_id = $1 AND d.event_name = 'day_two_wow'
       ) AS already`,
    [userId, orgId, VALUE_EVENTS],
    orgId || 'org-system'
  );
  const row = result.rows?.[0];
  if (!row || row.already || !row.signup_at || !row.first_value_at) return false;
  const now = Date.now();
  const signupMs = new Date(row.signup_at).getTime();
  const firstValueMs = new Date(row.first_value_at).getTime();
  const withinWindow = now - signupMs <= DAY_TWO_WINDOW_DAYS * 86400000;
  const realReturn = now - firstValueMs >= DAY_TWO_MIN_GAP_HOURS * 3600000;
  if (!withinWindow || !realReturn) return false;
  await productEvents.recordProductEvent(actor, {
    event_name: 'day_two_wow',
    source: 'context_sync',
    surface,
    metadata: {
      project_id: projectId,
      days_since_signup: Math.round((now - signupMs) / 86400000 * 10) / 10,
      hours_since_first_value: Math.round((now - firstValueMs) / 3600000),
    },
  });
  return true;
}

// first_sync_completed — the user's FIRST context delivery into any tool: the
// genuine "first sync" (context actually reached an AI session, vs. merely
// starting one). Emitted at most once per user; the emitted event is its own
// idempotence marker, exactly like day_two_wow / second_tool_connected. Two jobs:
//   1. Finally EMIT first_sync_completed — activationFollowUp and the catch-up
//      VALUE_EVENTS already consume it, but nothing ever produced it.
//   2. Mirror the activation to Reddit's CAPI as a custom "FirstSync" conversion
//      so an ad campaign can optimize toward activation, not just signup. The
//      hashed email matches the ad-exposed user; the signup's rdt_cid is
//      recovered from the account_created event to strengthen attribution.
// Strictly per-USER (not per-org) for the same reason day_two_wow is: a
// newly-invited member must not inherit a veteran teammate's activation. Legacy
// key-authed events (user_id NULL) fold in by org so an established solo account
// isn't reset. Best-effort; never blocks context delivery.
async function maybeEmitFirstSyncActivation(actor, { tool, projectId } = {}) {
  const userId = actorUserId(actor);
  const orgId = workspace.defaultOwnerKey(actor) || null;
  if (!userId && !orgId) return false;
  const result = await db.queryBestEffort(
    `SELECT
       EXISTS (
         SELECT 1 FROM product_events
          WHERE (user_id = $1 OR ${unownedEventsAreMine('$2')})
            AND event_name = 'first_sync_completed'
       ) AS already,
       (SELECT u.email FROM users u WHERE u.user_id = $1) AS email,
       (SELECT u.is_platform_staff FROM users u WHERE u.user_id = $1) AS is_platform_staff,
       (SELECT e.metadata->>'rdt_cid' FROM product_events e
         WHERE e.user_id = $1 AND e.event_name = 'account_created'
           AND e.metadata->>'rdt_cid' IS NOT NULL
         ORDER BY e.created_at ASC LIMIT 1) AS click_id,
       -- The Google ad-click id stored at signup: account_created carries the
       -- gclid/wbraid/gbraid the browser threaded through Clerk unsafeMetadata
       -- (auth-webhooks.js), and it is the ONLY place it is kept. Erasure
       -- deletes product_events by user_id, so nothing new needs erasing.
       (SELECT jsonb_build_object(
                 'gclid', e.metadata->>'gclid',
                 'wbraid', e.metadata->>'wbraid',
                 'gbraid', e.metadata->>'gbraid',
                 'signed_up_at', e.created_at)
          FROM product_events e
         WHERE e.user_id = $1 AND e.event_name = 'account_created'
           AND (e.metadata->>'gclid' IS NOT NULL
                OR e.metadata->>'wbraid' IS NOT NULL
                OR e.metadata->>'gbraid' IS NOT NULL)
         ORDER BY e.created_at ASC LIMIT 1) AS google_click`,
    [userId, orgId],
    orgId || 'org-system'
  );
  const row = result.rows?.[0];
  if (!row || row.already) return false;
  const firstSyncAt = new Date();
  await productEvents.recordProductEvent(actor, {
    event_name: 'first_sync_completed',
    source: 'context_sync',
    surface: tool,
    metadata: { project_id: projectId || null, tool: tool || null },
  });
  // Activation is what pays whoever referred this person. Lazy require: the
  // referral service reaches back into product events.
  if (userId) {
    require('./referralService')
      .activateReferralForActor({ id: userId, org_id: orgId }, 'first_sync')
      .catch((err) => console.warn('[CATCHUP] referral activation failed:', err.message));
  }
  // Mirror to Reddit CAPI. conversion_id = user_id is a stable dedup key, so even
  // a race that double-emits collapses to one conversion at Reddit. Only fire for
  // a resolved user (org-only actors have no email to match on). Fire-and-forget.
  //
  // Never for one of ours. The signup mirror has always skipped +clerk_test
  // journeys (auth-webhooks.js); this one never did, so the weekly journey run
  // posted a real FirstSync to Reddit every Monday, and from 2026-08-28 to
  // 2026-09-30 that bot was the ONLY source of FirstSync conversions (8 of 8).
  // The ad platform optimises toward whatever it is sent. The product event
  // above still records — PostHog filters test persons on its own side.
  if (userId && !isInternalIdentity({ email: row.email, isPlatformStaff: row.is_platform_staff === true })) {
    trackRedditActivation({
      email: row.email || undefined,
      clickId: row.click_id || undefined,
      conversionId: userId,
    }).catch((err) => console.warn('[CATCHUP] reddit activation failed:', err.message));
    // Mirror to Google Ads as the SETUP conversion — the event the campaigns
    // should optimise toward, instead of the /start command-copy proxy. Same
    // internal-identity gate as Reddit. A no-op without a stored Google click
    // id or without GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID; orderId
    // `<userId>:setup` dedups a racing double-emit at Google. Fire-and-forget:
    // trackGoogleAdsSetup never throws, and nothing here awaits it.
    const g = row.google_click && typeof row.google_click === 'object' ? row.google_click : null;
    if (g && (g.gclid || g.wbraid || g.gbraid)) {
      trackGoogleAdsSetup({
        gclid: g.gclid || undefined,
        wbraid: g.wbraid || undefined,
        gbraid: g.gbraid || undefined,
        personId: userId,
        eventAt: firstSyncAt,
        signedUpAt: g.signed_up_at || undefined,
      }).catch((err) => console.warn('[CATCHUP] google ads setup failed:', err.message));
    }
  }
  return true;
}

// team_activated — the first week this workspace had two people's agents in it.
//
// THE METRIC THREE PLAN GATES ARE WRITTEN AGAINST, and until now nothing
// produced it. Oct 15 asks for three of these and there was no way to answer.
//
// Definition, chosen so it cannot be satisfied by anything but the product
// working: two DISTINCT people, each of whose agent called start_session and
// reached this server, inside the same seven days, in the same workspace. Not
// seats sold, not invites sent, not logins. A team that bought five seats and
// never connected has not activated, and this will say so.
//
// Counted from context_session_loads rather than from product_events, because
// that table gets a row per session load with the person on it, while the
// activation events are once-per-user-ever and so can never express a rolling
// window.
//
// Per WORKSPACE, unlike every other emitter here — those are strictly per-user
// so a new member cannot inherit a teammate's milestone. This one is the
// opposite by nature: it is a fact about the group, it fires once, and the
// event is its own idempotence marker. org_id on a product event resolves to
// the bound workspace, so that check is workspace-scoped too.
//
// Best-effort; never blocks a brief.
async function maybeEmitTeamActivated(actor, { tool } = {}) {
  const ownerKey = workspace.defaultOwnerKey(actor) || null;
  if (!ownerKey) return false;
  const result = await db.queryBestEffort(
    `SELECT
       EXISTS (
         SELECT 1 FROM product_events
          WHERE org_id = $1 AND event_name = 'team_activated'
       ) AS already,
       (SELECT COUNT(DISTINCT user_id)
          FROM context_session_loads
         WHERE owner_key = $1
           AND user_id IS NOT NULL
           AND created_at > NOW() - make_interval(days => $2)) AS members`,
    [ownerKey, TEAM_ACTIVATION_WINDOW_DAYS],
    ownerKey
  );
  const row = result.rows?.[0];
  if (!row || row.already !== false) return false;
  // user_id IS NOT NULL above is load-bearing: key-authed loads that predate
  // per-user attribution carry a null, and COUNT(DISTINCT) folds every one of
  // them into a single phantom member. A solo account with legacy rows would
  // otherwise activate as a team of two.
  const members = Number(row.members || 0);
  if (members < TEAM_ACTIVATION_MIN_MEMBERS) return false;
  await productEvents.recordProductEvent(actor, {
    event_name: 'team_activated',
    source: 'context_sync',
    surface: tool,
    metadata: {
      members,
      window_days: TEAM_ACTIVATION_WINDOW_DAYS,
      workspace: ownerKey,
    },
  });
  return true;
}

// connection_established — a start_session that actually reached the server and
// returned a brief, whether or not there was anything in it. This is deliberately
// NOT activation: first_sync_completed still means real context reached a tool.
//
// It exists because the first session of a brand-new account emits nothing at all.
// There is no project yet (buildSessionCatchup returns early, so no session_started)
// and no global context yet (the "No context set yet." fallback skips
// context_delivered), so a user could connect, get a working handshake, and leave no
// server-side trace whatsoever. In the 30d to 2026-08-19 that was every real
// connector: 1 user with 2 successful start_session calls and 0 recorded sessions.
//
// Emitted at most once per user; the event is its own idempotence marker, exactly
// like first_sync_completed / day_two_wow. Strictly per-USER so a newly-invited
// member does not inherit a teammate's connection; legacy key-authed events
// (user_id NULL) fold in by org. Best-effort; never blocks the brief.
async function maybeEmitConnectionEstablished(actor, { tool } = {}) {
  const userId = actorUserId(actor);
  const orgId = workspace.defaultOwnerKey(actor) || null;
  if (!userId && !orgId) return false;
  const result = await db.queryBestEffort(
    `SELECT EXISTS (
       SELECT 1 FROM product_events
        WHERE (user_id = $1 OR ${unownedEventsAreMine('$2')})
          AND event_name = 'connection_established'
     ) AS already`,
    [userId, orgId],
    orgId || 'org-system'
  );
  if (result.rows?.[0]?.already !== false) return false;
  await productEvents.recordProductEvent(actor, {
    event_name: 'connection_established',
    source: 'context_sync',
    surface: tool,
    metadata: { tool: tool || null },
  });
  return true;
}

// The activation emit-set for the HOSTED transport (Claude.ai, ChatGPT, any
// remote connector). Its start_session answers from getWorkspaceOverview and
// never goes through contextSyncService.renderInjection — which is the only
// place context_delivered and first_sync_completed are emitted. So until this
// existed, a hosted user could authorize, call start_session, receive their
// entire workspace context, and still never register as activated: activation
// was structurally unreachable from every no-install surface. All three users
// in the 2026-08 warm list who reached mcp_runtime_started without a first sync
// were on it; one called start_session successfully twice. session_started and
// day_two_wow already fired there via buildSessionCatchup, but only when a
// project was active — these were missing outright.
//
// Mirrors renderInjection's emit set and its semantics exactly:
//   - connection_established: once per user, on BOTH branches. A tool reached us
//     and got a real answer. Necessary for activation, never sufficient.
//   - context_delivered + first_sync_completed: ONLY when real context actually
//     went out. An empty workspace ("No DeerDawn context yet") delivered nothing,
//     so counting it would put a false activation in the funnel.
// source is 'context_sync', not 'mcp', because this IS a context delivery: any
// query filtering context_delivered by source must see the hosted surface too,
// or it recreates this bug one layer up. `surface` still separates hosted from
// local. Fire-and-forget — telemetry must never add latency to, or fail, a call.
function recordRemoteSessionDelivery(actor, { surface, projectId, delivered, matchKind = null, matchGuessed = false } = {}) {
  maybeEmitConnectionEstablished(actor, { tool: surface })
    .catch((err) => console.warn('[CATCHUP] connection_established check failed:', err.message));
  if (!delivered) return;
  productEvents.recordProductEvent(actor, {
    event_name: 'context_delivered',
    source: 'context_sync',
    surface,
    // Hosted by definition: this is the hosted dispatcher's delivery.
    transport: connectionIdentity.hostedTransport(actor),
    // match_kind / match_guessed: HOW the project was chosen, so the share of
    // sessions that open on a guess (and are then corrected,
    // session_project_corrected) is readable rather than inferred.
    metadata: {
      project_id: projectId || null, tool: surface, scope: 'workspace_overview', transport: 'http',
      match_kind: matchKind || null, match_guessed: Boolean(matchGuessed),
    },
  }).catch((err) => console.warn('[CATCHUP] context_delivered event failed:', err.message));
  maybeEmitFirstSyncActivation(actor, { tool: surface, projectId: projectId || null })
    .catch((err) => console.warn('[CATCHUP] first_sync_completed check failed:', err.message));
}


/**
 * team_context_received — THE team activation event.
 *
 * Fires the first time a person's brief carries somebody ELSE'S work. Not
 * signup, not connection, not first sync: those all measure a person setting the
 * product up, and every one of them can be true while the thing being sold has
 * never happened. This is the event that says a shared workspace actually
 * delivered — the whole premise, reduced to one moment.
 *
 * Once per person PER WORKSPACE. A second team is a second activation, because
 * joining a new team is a new instance of the thing working; but a teammate's
 * every subsequent session is not, or the metric becomes a usage counter.
 *
 * Best-effort throughout, like everything else on this path — the brief must
 * never depend on an event landing.
 */
async function maybeEmitTeamContextReceived(actor, surface, projectId, teamDelta) {
  if (!teamDelta?.rows?.length) return false;
  const userId = actorUserId(actor);
  const ownerKey = workspace.defaultOwnerKey(actor) || null;
  if (!userId || !ownerKey) return false;

  const result = await db.queryBestEffort(
    `SELECT EXISTS (
       SELECT 1 FROM product_events
        WHERE user_id = $1 AND org_id = $2 AND event_name = 'team_context_received'
     ) AS already`,
    [userId, ownerKey],
    ownerKey,
  );
  if (result.rows?.[0]?.already) return false;

  await productEvents.recordProductEvent(actor, {
    event_name: 'team_context_received',
    source: 'context_sync',
    surface,
    metadata: {
      project_id: projectId,
      // How many DISTINCT colleagues' work reached them, and how much of it —
      // one teammate's single decision and four teammates' twenty are both
      // activation, but they are not the same event to reason about.
      contributor_count: teamDelta.author_count,
      item_count: teamDelta.rows.length,
    },
  });
  return true;
}

async function emitSessionEvents(actor, { projectId, tool, load, gapMs, since, teamDelta }) {
  // second_tool_connected reads only source='mcp' surfaces (real tool identity)
  // and unions `tool` in, so it is order-independent w.r.t. the session_started
  // insert below (which is source='context_sync' and never enters that set). On
  // the remote path `tool` is 'unknown_web' → non-identifying → this no-ops, and
  // detection instead runs at initialize where clientInfo gives the real surface.
  await maybeEmitSecondToolConnected(actor, tool)
    .catch((err) => console.warn('[CATCHUP] second_tool_connected check failed:', err.message));
  const gapHours = Number.isFinite(gapMs) ? Math.round(gapMs / 3600000 * 10) / 10 : null;
  await productEvents.recordProductEvent(actor, {
    event_name: 'session_started',
    source: 'context_sync',
    surface: tool,
    metadata: { project_id: projectId, session_number: load.session_number, gap_hours: gapHours },
  }).catch((err) => console.warn('[CATCHUP] session_started event failed:', err.message));
  // day_two_wow fires on ANY qualifying return session, NOT only when the catch-up
  // carries a non-empty delta. A user coming back ≥6h later within 7 days of signup
  // is the activation moment even if the project didn't change since — their tool
  // still opens briefed on the current state, which is the product's whole promise.
  // maybeEmitDayTwoWow has its own ≥6h / ≤7d / once-per-user gates. Previously this
  // was nested under `countDelta(since) > 0`, so it never fired for a return with an
  // empty delta — the root cause of day_two_wow reading 0 in PostHog.
  await maybeEmitDayTwoWow(actor, tool, projectId)
    .catch((err) => console.warn('[CATCHUP] day_two_wow check failed:', err.message));
  if (countDelta(since) > 0) {
    await productEvents.recordProductEvent(actor, {
      event_name: 'catchup_delivered',
      source: 'context_sync',
      surface: tool,
      metadata: {
        project_id: projectId,
        gap_hours: gapHours,
        shipped: since.shipped.length,
        decided: since.decided.length,
        landmines: since.landmines.length,
      },
    }).catch((err) => console.warn('[CATCHUP] catchup_delivered event failed:', err.message));
  }
  await maybeEmitTeamContextReceived(actor, tool, projectId, teamDelta)
    .catch((err) => console.warn('[CATCHUP] team_context_received check failed:', err.message));
}

/**
 * Record a real session start on a project and build the since-last-session
 * catch-up. `project` is a resolveActiveProject result (project_id,
 * project_name, context). Returns the structured delta plus a pre-rendered
 * compact text block, or null on any failure — callers treat the catch-up as
 * strictly additive to the brief.
 */
async function buildSessionCatchup(actor, project, tool, { transport = null, loadTool = null } = {}) {
  if (!project?.project_id) return null;
  try {
    const ownerKey = getActorKey(actor);
    // The PERSON, via the one sanctioned resolver: a key-authed actor's id is the
    // key, and an internal `{ id: ownerKey }` actor is nobody (null), which keeps
    // its read workspace-wide. The read is per person so a teammate's session
    // start cannot move this person's "since last session" cutoff.
    const personId = workspace.actorPersonId(actor);
    const identities = personId ? workspace.actorIdentities(actor) : null;
    // `loadTool` names the tool on the stored row when the caller knows it more
    // precisely than `tool` (the hosted surface, which files Claude Code, Codex
    // and Cursor as 'unknown_web'). Events below keep `tool`: their surfaces are
    // what second_tool_connected and the funnel are read by.
    const load = await store.recordSessionLoad(ownerKey, project.project_id, {
      userId: personId,
      identities,
      tool: loadTool || tool || null,
      transport: transport || null,
    });
    const lastMs = toMs(load.last_session_at);
    const gapMs = lastMs !== null ? Math.max(0, Date.now() - lastMs) : null;
    const gapHuman = gapMs !== null ? humanizeGap(gapMs) : null;
    const context = project.context || {};
    const since = buildSinceLastSession(context, load.last_session_at);
    const resumeHint = buildResumeHint(context);
    const previousLoad = buildPreviousLoad(load, context);

    // Only pay for the roster on a workspace that actually has teammates. A solo
    // account — still the overwhelming majority — does no extra query at all.
    let teamDelta = null;
    let contradictionText = null;
    // Only ever consulted alongside a team delta, and answered from what is
    // already loaded: a solo account does no extra work for it at all.
    let viewerIsNewHere = true;
    try {
      if (await workspace.isSharedWorkspace(ownerKey)) {
        viewerIsNewHere = !viewerHasStakeIn(project, identities || (personId ? [personId] : []));
        const members = await workspace.listMembers(ownerKey, { includeRemoved: true });
        const names = new Map(members.map((m) => [
          m.user_id,
          // A departed teammate is still named, and said to have left. Their
          // work stays in the brief, so anonymising them here would leave the
          // reader unable to place a claim they can no longer ask about.
          m.active ? (m.email || m.user_id) : `${m.email || m.user_id} (left the team)`,
        ]));
        // THE CUTOFF FOR THE TEAM DELTA IS NOT ALWAYS "your last session".
        //
        // Somebody reading this project for the first time has no last session,
        // so load.last_session_at is null and the attributed filter — which
        // treats a null cutoff as "nothing qualifies" — returned an empty set on
        // the one session where the team delta is the entire point. Fall back to
        // a bounded recent window instead of to silence. Only this delta is
        // widened: since_last_session stays honestly empty, because it is a claim
        // about THEIR history and they have none.
        teamDelta = buildTeamDelta(
          buildAttributedEntries(context, teamDeltaCutoff(load.last_session_at)),
          personId,
          names,
        );

        // Run over ALL standing decisions, not just the ones since the last
        // session: a disagreement is between what is standing now and what was
        // standing before, and the older half is by definition outside the
        // window. Cheap — at most twenty entries, no model call.
        contradictionText = renderContradictions(
          detectContradictions(context.recent_decisions || []),
          names,
        );
      }
    } catch (err) {
      // Additive to the brief, exactly like the rest of this service.
      console.warn('[CATCHUP] team delta failed:', err.message);
    }

    const text = renderCatchupText({
      projectName: project.project_name || 'this project',
      load,
      gapMs,
      gapHuman,
      since,
      resumeHint,
      context,
      teamDelta,
      contradictionText,
      viewerIsNewHere,
      previousLoad,
    });

    // Instrumentation rides the same computation, off the request path.
    setImmediate(() => {
      emitSessionEvents(actor, { projectId: project.project_id, tool, load, gapMs, since, teamDelta })
        .catch((err) => console.warn('[CATCHUP] event emission failed:', err.message));
    });

    return {
      session_number: load.session_number,
      first_session_at: load.first_session_at,
      last_session_at: load.last_session_at,
      gap_seconds: gapMs !== null ? Math.round(gapMs / 1000) : null,
      gap_human: gapHuman,
      since_last_session: since,
      // NEW, beside the pinned since_last_session: where the previous session
      // happened and the task set since it. null on a first session.
      previous_session: previousLoad,
      team_delta: teamDelta,
      contradictions: contradictionText,
      resume_hint: resumeHint,
      text,
    };
  } catch (err) {
    console.warn('[CATCHUP] buildSessionCatchup failed:', err.message);
    return null;
  }
}

/**
 * Session one, recorded at the moment a project is CREATED from an MCP session.
 *
 * A brand-new account's first start_session has no project, so it writes no
 * load row; the person then creates a project and saves into it in that same
 * sitting. Without a row for that sitting, their next start_session is
 * "session 1" — and session 1 says nothing — so the day-two catch-up never
 * fired for exactly the person it exists for. This writes that row before the
 * first save, so the save lands after it and the next session's delta names it.
 *
 * Create only, never select: selecting an existing project is not the start of
 * its history, and booking a load there would move the person's "since last
 * session" cutoff past work they have not been shown. Callers gate on an MCP
 * session (hosted dispatch; the local server's explicit flag), so a project
 * made on the website is not a session. No events: this is the row, and only
 * the row — a create is not a brief delivered. Best-effort: never fails a create.
 */
async function recordCreationSessionLoad(actor, projectId, tool, { transport = null } = {}) {
  if (!projectId) return null;
  try {
    const personId = workspace.actorPersonId(actor);
    return await store.recordSessionLoad(getActorKey(actor), projectId, {
      userId: personId,
      identities: personId ? workspace.actorIdentities(actor) : null,
      tool: tool || null,
      transport: transport || null,
    });
  } catch (err) {
    console.warn('[CATCHUP] creation session load failed:', err.message);
    return null;
  }
}

module.exports = {
  buildSessionCatchup,
  recordCreationSessionLoad,
  buildPreviousLoad,
  buildSinceLastSession,
  buildResumeHint,
  humanizeGap,
  renderCatchupText,
  maybeEmitSecondToolConnected,
  maybeEmitDayTwoWow,
  maybeEmitFirstSyncActivation,
  recordRemoteSessionDelivery,
  maybeEmitConnectionEstablished,
  maybeEmitTeamActivated,
};
