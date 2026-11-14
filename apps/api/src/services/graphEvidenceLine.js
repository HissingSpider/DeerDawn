'use strict';

// ─── What an evidence row says, now that it no longer quotes anybody ─────────
//
// context_graph_evidence.excerpt held the first 400 characters of the raw
// conversation — `[user] ...\n[assistant] ...`, secrets redacted, in plaintext,
// once per entity — while /pricing, /security and the homepage said raw
// conversation text is never kept. The owner decided (2026-09-28) to stop
// storing it. An evidence row still has a job: it says why an entity exists and
// where it came from. So it keeps a line, but one the PRODUCT writes from
// structured facts — the entity's type and title, the project and the brief
// section it was recorded in — and never words copied out of the conversation.
// Which tool and when stay on the row itself (tool, created_at), where every
// reader already shows them.
//
// Two forms, because the two writers know different things. The live path
// (contextGraphService recordGraphArtifacts) writes deriveEvidenceLine: it has
// just derived the entity from a named section of the brief, so it can say
// which. The owner's one-off purge (scripts/purge-raw-excerpts.js) writes
// deriveReplacedExcerptLine over an OLD row, and all an old row records is the
// entity it points at, the project it was written in, and that the capture path
// wrote it while taking in a conversation. The section is not on the row: the
// node's type only suggests one, the node may have been merged or re-keyed
// since, and saying "recorded in X's tech stack" of it would state as fact a
// place nobody recorded (journey scan round 4).

// excerpt_kind, the marker column. Set by every writer that stores text the
// product wrote; NULL on every row written before this change. The purge uses it
// to tell a row it has already handled (or one the new path wrote) from an old
// one, instead of guessing from the text.
const EXCERPT_KIND_DERIVED = 'derived';

// The shape the old write path gave EVERY conversation excerpt: each chunk
// rendered as `[<role>] <text>`, joined by newlines, trimmed, clipped at 400. So
// an old raw excerpt always opens with a bracketed role and a space. The same
// pattern in both dialects: the SQL one drives the purge and its verification
// query, the JS one the tests.
const RAW_TRANSCRIPT_SQL_PATTERN = '^\\[[^]]{1,40}] ';
const RAW_TRANSCRIPT_PATTERN = /^\[[^\]]{1,40}\] /;

function isRawTranscriptExcerpt(text) {
  return RAW_TRANSCRIPT_PATTERN.test(String(text || ''));
}

// Where in the brief each derived entity comes from (contextGraphService
// deriveEntities): the tech stack, the file structure, the current task, the
// recent decisions. Nothing else writes evidence through this line.
const RECORDED = {
  service: (project) => `in ${project}'s tech stack`,
  file: (project) => `in ${project}'s file structure`,
  component: (project) => `in ${project}'s file structure`,
  task: (project) => `as ${project}'s current task`,
  decision: (project) => `in ${project}'s recent decisions`,
};

function oneLine(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function entityLabel({ nodeType, title }) {
  const type = String(nodeType || 'entity').trim() || 'entity';
  const name = oneLine(title, 120);
  return { type, text: `${type.charAt(0).toUpperCase() + type.slice(1)}${name ? ` "${name}"` : ''}` };
}

/**
 * The evidence line for an entity recorded in a project.
 *
 *   deriveEvidenceLine({ nodeType: 'decision', title: 'Cap retries at five', projectName: 'Atlas' })
 *   → 'Decision "Cap retries at five" recorded in Atlas\'s recent decisions.'
 *
 * `title` is the node's title as stored; `projectName` may be missing (the
 * project was deleted since), and then the line says "a project".
 */
function deriveEvidenceLine({ nodeType, title, projectName }) {
  const { type, text } = entityLabel({ nodeType, title });
  const project = oneLine(projectName, 120);
  const where = RECORDED[type]
    ? ` ${RECORDED[type](project || 'a project')}`
    : project ? ` in ${project}` : '';
  return `${text} recorded${where}.`;
}

/**
 * The line the purge writes in place of an OLD raw conversation excerpt. It
 * claims only what such a row records: the entity (its type and title), the
 * project the row was written in, and that it came from a captured conversation.
 * Which tool captured it and when stay on the row (tool, created_at), shown by
 * every reader beside the line — and are not repeated here, because /seed filed
 * every imported conversation, from whichever product, under claude_web.
 *
 *   deriveReplacedExcerptLine({ nodeType: 'service', title: 'Redis', projectName: 'Atlas' })
 *   → 'Service "Redis" recorded in Atlas from a captured conversation.'
 */
function deriveReplacedExcerptLine({ nodeType, title, projectName }) {
  const { text } = entityLabel({ nodeType, title });
  const project = oneLine(projectName, 120);
  return `${text} recorded in ${project || 'a project'} from a captured conversation.`;
}

module.exports = {
  EXCERPT_KIND_DERIVED,
  RAW_TRANSCRIPT_SQL_PATTERN,
  RAW_TRANSCRIPT_PATTERN,
  isRawTranscriptExcerpt,
  deriveEvidenceLine,
  deriveReplacedExcerptLine,
};
