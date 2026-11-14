/**
 * briefCard — the one thing the USER sees at session start.
 *
 * Everything else DeerDawn emits is written for the model. This card is written
 * for the human: it is proof that memory was loaded on their behalf, not a place
 * to read the memory itself. The model still relays the substance in prose; the
 * card exists so a product with deliberately zero daily interaction is not also
 * a product with zero daily evidence.
 *
 * Three rules it must keep:
 *
 *  1. THREE ROWS MAX. The moment this becomes a place to read context, it starts
 *     competing with the brief and both get skimmed.
 *  2. RENDERED SERVER-SIDE. The MCP server is installed on user machines and
 *     updates on their schedule, not ours. Rendering here means the card can
 *     change without anyone reinstalling anything. Callers treat the string as
 *     opaque and print it.
 *  3. NO EMOJI, NO COLOR, NO GRADIENTS. Box-drawing characters only. This renders
 *     into terminals of unknown width, theme, and font.
 *
 * The "Remembering" row is the retention mechanic, not decoration: it is the only
 * line describing the accumulated asset rather than today's work, and it is where
 * a free-tier fact aging out of the retention window becomes visible as a loss.
 */

'use strict';

// Lazily required inside buildBriefCard, not at module load: index.js exports this
// module, so a top-level require here would form a CommonJS cycle and resolve to a
// half-initialised exports object.

// 52 total. Wide enough for a useful value, narrow enough to survive a split
// terminal pane and a phone-width chat surface without wrapping — a wrapped card
// looks broken in a way a slightly cramped one does not.
const CARD_WIDTH = 52;
const INNER = CARD_WIDTH - 4; // '│ ' + content + ' │'
const LABEL_W = 12;
const VALUE_W = INNER - LABEL_W;

/**
 * Values flow in from model-written context, so treat them as untrusted for
 * RENDERING purposes: a newline or a box-drawing character in a project name
 * would let stored text forge card borders and fake a DeerDawn message. Strip
 * anything structural, collapse whitespace, and drop emoji (both a hard brand
 * rule and a width hazard — terminals disagree on how wide they are).
 */
function sanitize(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    // Control characters and line breaks — these would break out of the row.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Box drawing, block elements, geometric shapes — border forgery.
    .replace(/[\u2500-\u25ff]/g, '')
    // Emoji and pictographs (astral planes) — unpredictable terminal width.
    .replace(/[\u{1f000}-\u{1ffff}]/gu, '')
    // BMP arrows, dingbats, and the variation-selector / keycap machinery.
    .replace(/[\u2190-\u21ff\u2600-\u27bf\ufe0f\u20e3]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, width) {
  const clean = sanitize(text);
  if (clean.length <= width) return clean;
  if (width <= 1) return clean.slice(0, width);
  // Trim to a word boundary when one is close by, so values end on a word rather
  // than mid-token — a truncated word reads as corruption, an elided phrase does not.
  const cut = clean.slice(0, width - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > width - 12 ? cut.slice(0, lastSpace) : cut;
  return `${body}…`;
}

function row(content) {
  const text = content.length > INNER ? content.slice(0, INNER) : content;
  return `│ ${text.padEnd(INNER, ' ')} │`;
}

function labelledRow(label, value) {
  const l = truncate(label, LABEL_W - 1).padEnd(LABEL_W, ' ');
  return row(`${l}${truncate(value, VALUE_W)}`);
}

/** Title row: project name left, recency right, elided from the left if tight. */
function titleRow(projectName, recency) {
  const right = truncate(recency, 20);
  const leftRoom = INNER - right.length - 2;
  const left = truncate(projectName, Math.max(leftRoom, 8));
  const gap = Math.max(INNER - left.length - right.length, 1);
  return row(`${left}${' '.repeat(gap)}${right}`);
}

function topBorder() {
  // '┌ DEERDAWN ' is 11 chars; fill the rest and close.
  const label = '┌─ DEERDAWN ';
  return `${label}${'─'.repeat(CARD_WIDTH - label.length - 1)}┐`;
}

function bottomBorder() {
  return `└${'─'.repeat(CARD_WIDTH - 2)}┘`;
}

function frame(lines) {
  return [topBorder(), ...lines, bottomBorder()].join('\n');
}

/**
 * Pick the "since last session" value. Prefers the server-computed catch-up delta
 * (which knows the real gap and what changed), falls back to the most recent
 * shipped item, and returns null rather than inventing continuity — claiming
 * progress that did not happen is the one failure mode that destroys trust in a
 * memory product.
 */
function sinceRow(catchup, spine) {
  // The gap phrase IS the label ("Yesterday", "3 days ago"). Prefixing it with
  // "Since" overflows the label column and buys nothing — the row's position
  // already says this is what changed while they were gone.
  const gap = sanitize(catchup && catchup.gap_human);
  const label = gap && gap.length <= LABEL_W - 1
    ? gap.charAt(0).toUpperCase() + gap.slice(1)
    : 'Since';

  // buildSessionCatchup's since_last_session is the authoritative delta: entries
  // whose timestamp is strictly after the previous session ended. Shipped work
  // outranks decisions, which outrank landmines — the user wants "what got done"
  // first. Count the rest so a busy gap reads as busy in one glance.
  const since = catchup && catchup.since_last_session;
  if (since) {
    const buckets = [since.shipped, since.decided, since.landmines]
      .map((b) => (Array.isArray(b) ? b.filter(Boolean) : []));
    const total = buckets.reduce((n, b) => n + b.length, 0);
    const lead = buckets.find((b) => b.length)?.[0];
    if (lead) {
      const more = total - 1;
      // Reserve room for the "+N more" suffix rather than letting truncate eat it.
      const suffix = more > 0 ? ` +${more} more` : '';
      const value = suffix
        ? `${truncate(lead, VALUE_W - suffix.length)}${suffix}`
        : lead;
      return { label, value };
    }
  }

  const shipped = spine && Array.isArray(spine.shipped) && spine.shipped[0];
  if (shipped && shipped.text) return { label, value: shipped.text };

  return null;
}

/** The single open thread — what the user would pick up if they sat down now. */
function openRow(spine, nextAction) {
  if (nextAction) return { label: 'Open', value: nextAction };
  const open = spine && Array.isArray(spine.open) && spine.open[0];
  if (open && open.text) return { label: 'Open', value: open.text };
  const decided = spine && Array.isArray(spine.decided) && spine.decided[0];
  if (decided && decided.text) return { label: 'Decided', value: decided.text };
  return null;
}

/**
 * The accumulated asset. Counts are cumulative, not windowed — the point is that
 * the number only goes up, which is what makes it register as something owned and
 * therefore something losable.
 */
function rememberingRow(totals) {
  if (!totals) return null;
  const parts = [];
  if (totals.decisions > 0) parts.push(`${totals.decisions} decision${totals.decisions === 1 ? '' : 's'}`);
  if (totals.projects > 0) parts.push(`${totals.projects} project${totals.projects === 1 ? '' : 's'}`);
  if (!parts.length) return null;
  return { label: 'Remembering', value: parts.join(' · ') };
}

/**
 * Build the session-start card.
 *
 * Returns null when there is nothing honest to show — callers must handle null by
 * printing nothing at all. A card that appears with no content teaches the user to
 * ignore the card.
 *
 * @param {object}  input
 * @param {string?} input.projectName
 * @param {string?} input.lastUpdated   ISO timestamp of the last context write
 * @param {object?} input.catchup       /active catchup payload
 * @param {object?} input.spine         buildBriefSpine() output
 * @param {object?} input.totals        { decisions, projects } cumulative counts
 * @param {string?} input.nextAction    explicit next action, if recorded
 * @param {boolean} input.isFirstSession
 * @returns {string|null}
 */
function buildBriefCard(input = {}) {
  const {
    projectName,
    lastUpdated,
    catchup = null,
    spine = null,
    totals = null,
    nextAction = null,
    isFirstSession = false,
  } = input;

  const name = sanitize(projectName);

  // First session on a project we just started tracking: there is no memory to
  // show yet, so set the expectation instead of rendering an empty frame. This is
  // the highest-traffic version of the card for a new user — the moment the
  // product explains what it is about to do for them.
  if (!name || isFirstSession) {
    return frame([
      row(name ? `Now tracking ${truncate(name, INNER - 13)}` : 'Session memory active'),
      row(''),
      row('This session will be captured. Your next one'),
      row('starts with a brief instead of a blank slate.'),
    ]);
  }

  const rows = [];
  const since = sinceRow(catchup, spine);
  if (since) rows.push(since);
  const open = openRow(spine, nextAction);
  if (open) rows.push(open);
  const remembering = rememberingRow(totals);
  if (remembering) rows.push(remembering);

  // A card with a title and no rows is just a logo. Suppress it — the model's
  // prose already carries the project name.
  if (!rows.length) return null;

  const { timeAgo } = require('./index.js');
  const recency = lastUpdated ? `briefed ${timeAgo(lastUpdated)}` : '';
  return frame([
    titleRow(name, recency),
    row(''),
    ...rows.map((r) => labelledRow(r.label, r.value)),
  ]);
}

module.exports = {
  buildBriefCard,
  CARD_WIDTH,
  // Exported for tests and for callers that need to compose a card-shaped notice.
  __internals: { sanitize, truncate, row, frame },
};
