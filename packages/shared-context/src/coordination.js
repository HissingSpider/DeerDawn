'use strict';

/**
 * coordination — multi-agent presence, holds, and staleness.
 *
 * Concurrent agents in one project collide in two ways nothing else in the stack
 * catches: semantic interference (A changes a contract while B is mid-edit in a
 * caller — no line overlap, so git sees nothing) and decision divergence (A
 * concludes X, B concludes not-X, last write to memory wins silently).
 *
 * Everything here obeys four rules, in this order of importance:
 *
 *   1. ADVISORY, NEVER ENFORCING. Every function reports; none blocks. A memory
 *      product that refuses an edit gets uninstalled, and then it protects nobody.
 *   2. DERIVED, NEVER DECLARED. Scope comes from calls agents already make (the
 *      card they moved, the paths they recorded), not from a claim verb they must
 *      remember to call. Unevenly-adopted coordination is worse than none: it
 *      makes a contended project look empty.
 *   3. TTL ON EVERYTHING. Crashed agents are the common case. Liveness is computed
 *      from timestamps at read time, so a dead session releases what it held by
 *      doing nothing at all.
 *   4. SILENT WHEN SOLO. Every renderer here returns null rather than an empty
 *      heading, so a single-agent session pays zero tokens for a feature that has
 *      nothing to say.
 *
 * See docs/MULTI-AGENT-COORDINATION-PLAN-2026-08.md.
 */

/**
 * How recently a session must have been seen to count as present.
 *
 * Deliberately generous. Under-reporting presence is the expensive failure —
 * it lets two agents collide believing they are alone — while over-reporting
 * costs a line in the brief about someone who stepped away. An agent thinking
 * between tool calls can easily be quiet for several minutes.
 */
const PRESENCE_WINDOW_SECONDS = 45 * 60;

/** Beyond this, a peer is listed but marked idle rather than working. */
const PRESENCE_IDLE_SECONDS = 10 * 60;

/**
 * How long a card stays held after the holder was last seen on it.
 *
 * Longer than the presence window on purpose: a hold surviving slightly past its
 * holder is the safe direction. Re-handing out a card whose agent is mid-edit
 * causes a real collision; briefly withholding one from a second agent costs a
 * few minutes and is visible in the "excluded" line that always accompanies it.
 */
const HOLD_TTL_MS = 90 * 60 * 1000;

const IN_PROGRESS_PHASE = 'in_progress';

function toMs(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** "4 min" / "2 hr" / "3 days" — compact enough for a brief line. */
function relativeAge(fromIso, nowMs = Date.now()) {
  const ms = toMs(fromIso);
  if (ms === null) return null;
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hr`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Is this card held, by whom, and is that hold still live?
 *
 * Returns `{ held, holder, ageMs, expired }`. A card is only ever held in the
 * In Progress column — a held card that has since been moved elsewhere reads as
 * unheld, so a stale `held_by` left on a Done card can never withhold work.
 */
function holdState(card, nowMs = Date.now()) {
  const NONE = { held: false, holder: null, ageMs: null, expired: false };
  if (!card || !card.held_by) return NONE;
  const phase = String(card.phase || '').toLowerCase();
  if (phase !== IN_PROGRESS_PHASE) return NONE;
  const heldAt = toMs(card.held_at);
  // A hold with no readable timestamp cannot be aged out, and an immortal hold
  // is exactly the deadlock rule 3 exists to prevent. Treat it as expired.
  if (heldAt === null) return { held: false, holder: String(card.held_by), ageMs: null, expired: true };
  const ageMs = Math.max(0, nowMs - heldAt);
  if (ageMs > HOLD_TTL_MS) return { held: false, holder: String(card.held_by), ageMs, expired: true };
  return { held: true, holder: String(card.held_by), ageMs, expired: false };
}

/** Is this card held by someone OTHER than the asking session? */
function isHeldByOther(card, sessionId, nowMs = Date.now()) {
  const state = holdState(card, nowMs);
  return state.held && state.holder !== String(sessionId || '');
}

/**
 * Split a card list into what this session may take and what is spoken for.
 *
 * Callers must surface `excluded` alongside `available`. Returning a short list
 * with no explanation reads as "there is no work left", which is the same class
 * of bug as silent truncation — the caller acts confidently on a filtered view
 * it does not know is filtered.
 */
function partitionHeldCards(cards, sessionId, nowMs = Date.now()) {
  const available = [];
  const excluded = [];
  for (const card of cards || []) {
    if (isHeldByOther(card, sessionId, nowMs)) {
      const state = holdState(card, nowMs);
      excluded.push({ card, holder: state.holder, age: relativeAge(card.held_at, nowMs) });
    } else {
      available.push(card);
    }
  }
  return { available, excluded };
}

/** One line naming what was withheld and by whom. Null when nothing was. */
function formatExcludedLine(excluded) {
  if (!excluded || !excluded.length) return null;
  const holders = [...new Set(excluded.map((e) => e.holder).filter(Boolean))];
  const who = holders.length ? ` (held by ${holders.join(', ')})` : '';
  return `${excluded.length} card${excluded.length > 1 ? 's' : ''} hidden${who}.`;
}

/** Apply/clear a hold as a card moves. Returns the card unchanged when no session is known. */
function applyHold(card, phase, sessionId, nowIso) {
  if (String(phase).toLowerCase() !== IN_PROGRESS_PHASE) {
    // Leaving In Progress always releases, even with no session id — otherwise a
    // hold could outlive the work and withhold a card nobody is on.
    return (card.held_by || card.held_at) ? { ...card, held_by: null, held_at: null } : card;
  }
  if (!sessionId) return card;
  return { ...card, held_by: String(sessionId), held_at: nowIso };
}

const TOOL_LABELS = {
  claude_code: 'Claude Code',
  claude_web: 'Claude',
  chatgpt_web: 'ChatGPT',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
};

/** Shorten a path for a brief line without losing which area it names. */
function shortenScope(value, max = 46) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `…${text.slice(-(max - 1))}`;
}

/**
 * The presence block: who else is in this project right now.
 *
 * Returns null unless at least one live peer exists, so a solo session renders
 * nothing at all (rule 4) — not a heading, not a blank line.
 *
 * @param {Array} peers - `{ session_id, tool, last_seen_at, cwd, held_cards, scope }`
 */
function formatPresenceBlock(peers, options = {}) {
  const nowMs = options.now ? toMs(options.now) || Date.now() : Date.now();
  const live = (peers || []).filter((p) => {
    const seen = toMs(p?.last_seen_at);
    return seen !== null && (nowMs - seen) / 1000 <= PRESENCE_WINDOW_SECONDS;
  });
  if (!live.length) return null;

  const lines = [`${live.length} other agent${live.length > 1 ? 's' : ''} active on this project`];
  for (const peer of live) {
    const seenMs = toMs(peer.last_seen_at);
    const idle = seenMs !== null && (nowMs - seenMs) > PRESENCE_IDLE_SECONDS * 1000;
    const tool = TOOL_LABELS[peer.tool] || peer.tool || 'agent';
    const age = relativeAge(peer.last_seen_at, nowMs);
    const state = idle ? `${age} idle` : `active ${age} ago`;
    // Scope is DERIVED (rule 2) — the card they hold and the paths they just
    // wrote — so a peer that never declared anything still shows up with a real
    // area of work rather than an anonymous session id.
    const scope = [];
    const held = (peer.held_cards || []).map((c) => (typeof c === 'string' ? c : c?.title)).filter(Boolean);
    if (held.length) scope.push(`card "${held[0]}"${held.length > 1 ? ` +${held.length - 1}` : ''}`);
    const paths = (peer.scope || []).filter(Boolean).slice(0, 2).map((s) => shortenScope(s));
    if (paths.length) scope.push(`in ${paths.join(', ')}`);
    const detail = scope.length ? ` — ${scope.join(', ')}` : '';
    lines.push(`  · ${peer.session_id} (${tool}, ${state})${detail}`);
  }
  // The block states a fact; it does not tell the agent to stop. Enforcement is
  // the model's call with this in hand (rule 1).
  lines.push('  Overlapping work is advisory — coordinate rather than assuming exclusivity.');
  return lines.join('\n');
}

/**
 * The staleness banner: what changed under this session since its brief was cut.
 *
 * Cheap by construction — it compares a watermark the caller already has against
 * one already loaded for another reason. If computing it needs its own query, the
 * banner belongs on a different call, not on a new round-trip (see the plan doc).
 */
function formatStalenessBanner(changes, options = {}) {
  const items = (changes || []).filter(Boolean);
  if (!items.length) return null;
  const max = options.max || 3;
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  const tail = more > 0 ? `, +${more} more` : '';
  return `${items.length} change${items.length > 1 ? 's' : ''} since your brief: ${shown.join('; ')}${tail}.`;
}

/**
 * Has the project moved since the watermark this session was briefed with?
 *
 * Watermarks are opaque strings to callers. Comparing timestamps rather than
 * counters means a write that lands during a session start is caught by the next
 * call instead of being lost.
 */
function isBriefStale(briefedWatermark, currentWatermark) {
  if (!briefedWatermark || !currentWatermark) return false;
  const a = toMs(briefedWatermark);
  const b = toMs(currentWatermark);
  if (a === null || b === null) return String(briefedWatermark) !== String(currentWatermark);
  return b > a;
}

module.exports = {
  PRESENCE_WINDOW_SECONDS,
  PRESENCE_IDLE_SECONDS,
  HOLD_TTL_MS,
  holdState,
  isHeldByOther,
  partitionHeldCards,
  formatExcludedLine,
  applyHold,
  formatPresenceBlock,
  formatStalenessBanner,
  isBriefStale,
  relativeAge,
};
