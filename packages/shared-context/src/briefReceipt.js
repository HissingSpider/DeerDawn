/**
 * formatBriefReceipt — the one data line every loaded brief starts with.
 *
 *   DeerDawn loaded {Project}: {n} decisions, {n} open questions, last saved {when}{ in tool}. Next: {next_action}
 *
 * It is DATA, not an instruction: it says what was loaded, so a person (and
 * their assistant) can see at a glance that memory arrived and how fresh it is.
 * It tells nobody to do anything.
 *
 * Honesty rules, the same ones the catch-up keeps:
 *   - a part we do not know is OMITTED, never guessed: no project name means no
 *     line at all; a count that is not a number, a timestamp that does not
 *     parse, a tool we cannot name and an empty next step each drop their own
 *     clause and nothing else;
 *   - the tool is named only when the caller vouches that the last save was
 *     made from it (see lastSavedTool below), never from "last tool seen".
 *
 * Single-source on purpose: the hosted dispatcher (apps/api/src/routes/mcp.js),
 * the local /active route and the local SessionStart hook all render it from
 * here, so the three cannot drift into describing the same brief differently.
 */

'use strict';

// Same names connectionIdentity.TOOL_LABELS uses (apps/api), kept local because
// this package cannot reach into the API. Anything not listed is not named:
// 'unknown_web' and friends are an absence of identity, not a tool.
const RECEIPT_TOOL_LABELS = Object.freeze({
  claude_code: 'Claude Code',
  claude_desktop: 'Claude Desktop',
  claude_web: 'Claude',
  chatgpt_web: 'ChatGPT',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A label for a stored tool id, or null when the id names no known tool. */
function receiptToolLabel(tool) {
  const id = String(tool || '').trim().toLowerCase();
  return RECEIPT_TOOL_LABELS[id] || null;
}

/**
 * Elapsed time in words. Coarse on purpose, like the catch-up's gap phrasing:
 * "3 hours ago" lands, "3h 12m ago" does not. null for anything unparseable or
 * in the future beyond clock skew.
 */
function receiptWhen(at, now = Date.now()) {
  const t = at instanceof Date ? at.getTime() : Date.parse(at || '');
  const n = now instanceof Date ? now.getTime() : (typeof now === 'string' ? Date.parse(now) : Number(now));
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  const ms = n - t;
  // A minute of skew between the writer's clock and ours is "just now"; more
  // than that in the future is a timestamp we cannot account for.
  if (ms < -MINUTE) return null;
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(ms / DAY);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}

// One line, always: a newline inside a stored value must not spawn a second
// line that reads as something the tool itself wrote.
function oneLine(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 3).join('').replace(/\s+\S*$/, '')}...` : text;
}

function countClause(n, singular, plural) {
  if (!Number.isInteger(n) || n < 0) return null;
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * @param {object} input
 * @param {string} input.projectName       required; no name, no line
 * @param {number} [input.decisions]       active (unresolved) decisions in the brief
 * @param {number} [input.openQuestions]   open questions in the brief
 * @param {string|Date} [input.lastSavedAt] when the project was last saved
 * @param {string} [input.lastSavedTool]   tool id the last save came from, ONLY when known
 * @param {string} [input.nextAction]      the stored next step, verbatim
 * @param {string|number|Date} [input.now] clock, injectable for tests
 * @returns {string|null}
 */
function formatBriefReceipt(input = {}) {
  const name = oneLine(input.projectName, 80);
  if (!name) return null;

  const facts = [
    countClause(input.decisions, 'decision', 'decisions'),
    countClause(input.openQuestions, 'open question', 'open questions'),
  ];
  const when = input.lastSavedAt ? receiptWhen(input.lastSavedAt, input.now ?? Date.now()) : null;
  if (when) {
    const tool = receiptToolLabel(input.lastSavedTool);
    facts.push(`last saved ${when}${tool ? ` in ${tool}` : ''}`);
  }
  const shown = facts.filter(Boolean);
  let line = `DeerDawn loaded ${name}${shown.length ? `: ${shown.join(', ')}` : ''}.`;
  const next = oneLine(input.nextAction, 140);
  if (next) line += ` Next: ${next}`;
  return line;
}

/**
 * The receipt's inputs, read off a stored project the way every brief reads it.
 *
 * `lastSavedTool` is the trap. A tool is named only when it was positively
 * identified: never for a save whose presence entry says identified:false.
 * `context.last_active_tool` is stamped only by the
 * extraction save path, so after a dashboard edit or a task write it still names
 * whichever tool made the extraction save before that. It is used only when that
 * tool's own presence stamp — written in the same statement — sits within two
 * minutes of the project's updated_at, i.e. when the last save WAS that tool's.
 */
function briefReceiptInputs(project, { now } = {}) {
  if (!project) return null;
  const context = project.context || {};
  // A section the reader's share policy withheld is not EMPTY, so it gets no
  // count at all: "0 decisions" over decisions you may not see would be false.
  const withheld = new Set(Array.isArray(context.withheld_sections) ? context.withheld_sections : []);
  const decisions = withheld.has('recent_decisions') ? null
    : (Array.isArray(context.recent_decisions) ? context.recent_decisions : [])
      .filter((d) => d && d.summary && d.resolved !== true).length;
  const openQuestions = withheld.has('open_questions') ? null
    : (Array.isArray(context.open_questions) ? context.open_questions : [])
      .filter((q) => typeof q === 'string' && q.trim()).length;
  const lastSavedAt = project.updated_at || context.last_updated || null;
  let lastSavedTool = null;
  const tool = context.last_active_tool;
  const presence = tool && context.tool_presence ? context.tool_presence[tool] : null;
  // A save made under a rendering DEFAULT (identified:false — the local server
  // could not place its client) names no tool: "in Claude Code" would be a guess.
  const stamp = presence && presence.identified !== false
    ? Date.parse(presence.last_seen_at || '')
    : NaN;
  const savedMs = lastSavedAt instanceof Date ? lastSavedAt.getTime() : Date.parse(lastSavedAt || '');
  if (Number.isFinite(stamp) && Number.isFinite(savedMs) && Math.abs(savedMs - stamp) <= 2 * MINUTE) {
    lastSavedTool = tool;
  }
  return {
    projectName: project.project_name || context.project_name || '',
    decisions,
    openQuestions,
    lastSavedAt,
    lastSavedTool,
    // A finished task's next step is the cursor inside work that is over.
    nextAction: context.task_progress === 'completed' || withheld.has('current_task') ? '' : (context.next_action || ''),
    now,
  };
}

module.exports = {
  formatBriefReceipt,
  briefReceiptInputs,
  receiptToolLabel,
  receiptWhen,
};
