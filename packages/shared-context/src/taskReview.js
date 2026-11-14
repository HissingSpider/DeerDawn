'use strict';

// ─── finish_task: the confirmation clears what the review showed ─────────────
//
// finish_task is two calls. The first is the wrap-up review: it names the open
// questions, the blocking issue and the command log attached to the task, and
// says "Completing this task would clear ...". The second, with complete_task
// and confirm_complete, clears them. It cleared the project's state AS IT WAS
// AT THE CONFIRMATION, so a question added in between, by the person or by
// another tool, was cleared without anybody having seen it (journey BLOCKED 22).
//
// The owner's decision: the confirmation clears exactly the items the review
// showed; anything added since stays, and the reply says what stayed.
//
// These helpers are the rule, for BOTH dispatchers (hosted apps/api
// routes/mcp.js, local packages/mcp-server tools/context-sync.ts), so they
// cannot disagree about what "the items the review showed" means. Where the
// review is REMEMBERED is each dispatcher's own: the hosted one in the database,
// per connection and project, as digests (never the text: the brief is
// encrypted at rest and a second copy of it in plaintext would not be); the
// local one in its own process, which is the session.
//
// What a review shows is what its "would clear" sentence names: every open
// question, the blocking issue, and every command log entry. An item is the
// same item when its text is (outer whitespace aside); a command is its label
// and its run. A question edited after the review is a different question, and
// stays.

function reviewQuestionKey(question) {
  return typeof question === 'string' ? question.trim() : '';
}

function reviewCommandKey(command) {
  if (typeof command === 'string') return command.trim();
  if (!command || typeof command !== 'object') return '';
  return JSON.stringify([String(command.label ?? '').trim(), String(command.run ?? '').trim()]);
}

/**
 * The items a wrap-up review of `context` shows, as keys. `digest` maps each
 * key to what is remembered (identity by default; the hosted dispatcher passes
 * a hash).
 */
function taskReviewItems(context, { digest = (key) => key } = {}) {
  const ctx = context || {};
  const questions = (Array.isArray(ctx.open_questions) ? ctx.open_questions : [])
    .map(reviewQuestionKey)
    .filter(Boolean);
  const blocker = String(ctx.blocking_issue || '').trim();
  const commands = (Array.isArray(ctx.commands) ? ctx.commands : [])
    .map(reviewCommandKey)
    .filter(Boolean);
  return {
    questions: questions.map(digest),
    blocker: blocker ? digest(blocker) : '',
    commands: commands.map(digest),
  };
}

// The three task-state fields a completion clears, each with the share section
// it belongs to (the section key a share policy and `skipped_sections` use).
const TASK_STATE_FIELDS = ['commands', 'open_questions', 'blocking_issue'];

// THE CALLER'S VIEW, NEVER THE STORED ROW (journey r4, M1).
//
// A teammate reads a shared project through its share policy: a section it
// withholds is ABSENT from their view (filterContextBySectionPolicy copies only
// the allowed fields and marks the view with `withheld_sections`). The review
// is taken from that view, so the confirmation must be planned from the same
// view: planned from the stored row, every hidden question and the hidden
// blocker counted as "added after the review" and were quoted back to someone
// the share hides them from. A field is viewable when the view is not
// section-filtered, or when the filter kept it.
function viewableTaskFields(context) {
  const ctx = context || {};
  const filtered = Array.isArray(ctx.withheld_sections);
  return new Set(TASK_STATE_FIELDS.filter((field) => !filtered || ctx[field] !== undefined));
}

/**
 * What a confirmed completion of `context` clears, given the review it
 * confirms. `context` is the CALLER'S view (see viewableTaskFields); `reviewed`
 * is taskReviewItems' output from the review (same `digest`). Returns:
 *   patch   — every task-state field the caller can view, with what the review
 *             showed taken out (so a section the caller may view but not edit
 *             is skipped and named by the server, as it always was); nothing of
 *             a field the caller cannot view
 *   cleared — { questions, blocker, commands }: counts (blocker a boolean)
 *   stayed  — { questions: [text], blocker: text, commands: count }: viewable,
 *             present now and not shown by the review, so left as they are
 *   hidden  — the task-state fields the caller cannot view: left alone, and
 *             to be named by section, never quoted
 */
function planReviewedCompletion(context, reviewed, { digest = (key) => key } = {}) {
  const view = context || {};
  const viewable = viewableTaskFields(view);
  const ctx = {
    open_questions: viewable.has('open_questions') ? view.open_questions : [],
    commands: viewable.has('commands') ? view.commands : [],
    blocking_issue: viewable.has('blocking_issue') ? view.blocking_issue : '',
  };
  const seenQuestions = new Set(Array.isArray(reviewed?.questions) ? reviewed.questions : []);
  const seenCommands = new Set(Array.isArray(reviewed?.commands) ? reviewed.commands : []);
  const seenBlocker = typeof reviewed?.blocker === 'string' ? reviewed.blocker : '';

  const questions = Array.isArray(ctx.open_questions) ? ctx.open_questions : [];
  const keptQuestions = [];
  const stayedQuestions = [];
  let clearedQuestions = 0;
  for (const question of questions) {
    const key = reviewQuestionKey(question);
    if (key && seenQuestions.has(digest(key))) {
      clearedQuestions += 1;
      continue;
    }
    keptQuestions.push(question);
    if (key) stayedQuestions.push(key);
  }

  const commands = Array.isArray(ctx.commands) ? ctx.commands : [];
  const keptCommands = [];
  let clearedCommands = 0;
  for (const command of commands) {
    const key = reviewCommandKey(command);
    if (key && seenCommands.has(digest(key))) {
      clearedCommands += 1;
      continue;
    }
    keptCommands.push(command);
  }

  const blocker = String(ctx.blocking_issue || '').trim();
  const clearBlocker = Boolean(blocker) && Boolean(seenBlocker) && digest(blocker) === seenBlocker;

  const patch = {};
  if (viewable.has('commands')) patch.commands = keptCommands;
  if (viewable.has('open_questions')) patch.open_questions = keptQuestions;
  if (viewable.has('blocking_issue')) patch.blocking_issue = clearBlocker ? '' : String(ctx.blocking_issue || '');

  return {
    patch,
    hidden: TASK_STATE_FIELDS.filter((field) => !viewable.has(field)),
    cleared: { questions: clearedQuestions, blocker: clearBlocker, commands: clearedCommands },
    stayed: {
      questions: stayedQuestions,
      blocker: blocker && !clearBlocker ? blocker : '',
      commands: keptCommands.length,
    },
  };
}

/**
 * `stayed`, less the sections the write skipped because the caller may not
 * edit them: those are named by section ("Left as they were (not shared for
 * editing with you): …"), never quoted one by one as "added after the review".
 */
function stayedOutside(stayed, skippedSections) {
  const skipped = skippedSections instanceof Set ? skippedSections : new Set(skippedSections || []);
  return {
    questions: skipped.has('open_questions') ? [] : (stayed?.questions || []),
    blocker: skipped.has('blocking_issue') ? '' : (stayed?.blocker || ''),
    commands: skipped.has('commands') ? 0 : (Number(stayed?.commands) || 0),
  };
}

// The order `main` names left-alone sections in: the order the completion's
// patch carries them, then the shipped list its event writes.
const LEFT_SECTION_ORDER = ['task_progress', 'commands', 'open_questions', 'blocking_issue', 'shipped', 'next_action'];
function orderLeftSections(sections) {
  const rank = (key) => { const i = LEFT_SECTION_ORDER.indexOf(key); return i < 0 ? LEFT_SECTION_ORDER.length : i; };
  return [...new Set(sections || [])].sort((a, b) => rank(a) - rank(b));
}

/** "N open questions, the blocking issue, M command log entries" — the words the review and the receipt already use. */
function describeTaskState({ questions = 0, blocker = false, commands = 0 } = {}) {
  return [
    questions ? `${questions} open question${questions === 1 ? '' : 's'}` : '',
    blocker ? 'the blocking issue' : '',
    commands ? `${commands} command log entr${commands === 1 ? 'y' : 'ies'}` : '',
  ].filter(Boolean);
}

/**
 * The sentence a confirmation adds when something was added after the review
 * and therefore left alone. '' when nothing stayed. Shaped like the receipt's
 * existing "Left as they were (not shared for editing with you): ..." line.
 */
function formatLeftAfterReview(stayed) {
  const questions = Array.isArray(stayed?.questions) ? stayed.questions : [];
  const blocker = String(stayed?.blocker || '').trim();
  const commands = Number(stayed?.commands) || 0;
  const parts = [];
  if (questions.length === 1) parts.push(`the open question "${questions[0]}"`);
  else if (questions.length > 1) parts.push(`${questions.length} open questions: ${questions.map((q) => `"${q}"`).join(', ')}`);
  if (blocker) parts.push(`the blocking issue "${blocker}"`);
  if (commands) parts.push(`${commands} command log entr${commands === 1 ? 'y' : 'ies'}`);
  return parts.length
    ? `Left as they were (added after the review, so not shown in it): ${parts.join('; ')}.`
    : '';
}

// A CONFIRMATION WITH NO REVIEW ON RECORD IS REFUSED (journey r4, the owner's
// decision). With none — the review was on another connection, the local
// server restarted in between, the connection moved to another project — the
// confirmation used to clear everything open at that moment, which nobody had
// been shown. Nothing is cleared and the assistant is sent to the review.
// Both dispatchers reply with these words.
const NO_REVIEW_ON_RECORD = 'Nothing was cleared: this task has not been reviewed here. Call manage_memory with action "finish_task" and without confirm_complete to review what completing it would clear, then confirm with complete_task=true and confirm_complete=true.';

module.exports = {
  NO_REVIEW_ON_RECORD,
  taskReviewItems,
  planReviewedCompletion,
  stayedOutside,
  orderLeftSections,
  describeTaskState,
  formatLeftAfterReview,
};
