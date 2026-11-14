// The markers versions before the install token wrote. Still READ, once, to
// migrate a block an older version left (see findOwnedBlock in setup-status.js);
// never written by anything that has a token.
const OPEN_MARKER = '<!-- deerdawn:auto-context -->';
const CLOSE_MARKER = '<!-- /deerdawn:auto-context -->';

// Every marker of this family, old and new, starts with this. For a check that
// asks "did a DeerDawn block get written here at all", not "is it ours".
const MARKER_NAME_PREFIX = '<!-- deerdawn:auto-context';

// ─── The block's identity ────────────────────────────────────────────────────
//
// The block sits in a file that is the person's (CLAUDE.md, AGENTS.md, the
// Cursor rule), and DeerDawn replaces what is between its two markers on every
// boot. A marker anybody can type is a marker anybody can forge by accident: a
// tutorial pasted into CLAUDE.md, another tool's copy of ours, a hand-typed
// lookalike would each be "DeerDawn's block" and be rewritten or deleted.
//
// So the markers carry a token that belongs to THIS install: 128 random bits
// made once and kept in DeerDawn's own config (~/.deerdawn/install.json). A pair
// counts as ours only when it carries that token. The token is an identity, not
// a secret: it is written into the person's file in the clear, and it is never
// sent anywhere. It exists so a look-alike cannot be mistaken for ours, and ours
// cannot be mistaken for anything else.
//
// The opening marker is the block's FIRST line and says, in plain words, what
// happens to edits inside it. The words are not part of what is matched (a later
// version may reword them), only the marker name and the token are.
const BLOCK_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const BLOCK_NOTICE = 'DeerDawn replaces anything edited between this line and the closing marker. Keep your own notes outside it.';

function isBlockToken(value) {
  return typeof value === 'string' && BLOCK_TOKEN_PATTERN.test(value);
}

function openMarkerFor(token) {
  return `${MARKER_NAME_PREFIX} ${token}. ${BLOCK_NOTICE} -->`;
}

function closeMarkerFor(token) {
  return `<!-- /deerdawn:auto-context ${token} -->`;
}

/** The marker set that finds a block carrying `token`, in the shape findManagedBlock takes. */
function ownedMarkersFor(token) {
  if (!isBlockToken(token)) throw new Error('a block token is 32 lowercase hex characters');
  return {
    open: openMarkerFor(token),
    // Matches the marker whatever notice follows the token, so a block written by
    // a version with other words is still found, and replaced with the current ones.
    openPattern: new RegExp(`^<!-- deerdawn:auto-context ${token}(?:[. ][^\r\n]*)? -->$`),
    close: closeMarkerFor(token),
    // DeerDawn's own block: see findManagedBlock. Only a pair at column 0 in plain
    // text is ours, not one inside a code block or an HTML comment.
    strict: true,
  };
}

// These lines are for a file the USER installs into their OWN repo (CLAUDE.md /
// AGENTS.md / .cursorrules). In that setting a directive voice is legitimate: it
// is the project owner instructing their own agent about their own codebase.
//
// They are deliberately NOT the MCP `instructions` field any more. Shipped as an
// app-level model-readable field, "always call start_session before your first
// response" / "do not answer until context has been loaded" / "use DeerDawn
// before repo search" is a third party steering the model, which failed ChatGPT
// directory review on 2026-08-24. Do not re-point mcpInstructions.js at this
// function - see the note there for the rule that applies to the wire format.

function buildDeerdawnInstructionLines() {
  return [
    '## DeerDawn',
    'Always call `start_session` before your first response — it is required to load current project context and sync files. Exception: a worker whose initial task begins with `[DeerDawn Subagent Brief v1]` treats that marked brief as its loaded task context and skips the full `start_session` unless the brief is incomplete or stale. Do not answer project questions or run repo search until context has been loaded by one of these paths.',
    'When delegating, call `build_subagent_brief` once per concrete subtask and pass only its returned brief. Use the host\'s isolated/no-history subagent mode when available; do not forward the full conversation or main DeerDawn brief.',
    'Use DeerDawn before repo search for orientation and known paths.',
    'Use repo search only when you need file-level or symbol-level resolution DeerDawn does not yet know.',
    'When `start_session` returns a "Since last session" catch-up, open with AT MOST two sentences: the most meaningful change anchored in time ("Last session (yesterday) you shipped X"), then the open thread as an offer ("Y is still open — want to pick that up?"). Then stop and let the user steer. Do not recite the full brief or list every field. If nothing changed, confirm readiness in one line. Never invent progress, decisions, or landmines not in the payload; state gaps as fact, never as reproach — no streak language.',
    'Call `manage_memory(action:"update", project_id, summary)` as soon as a decision is made, a task changes, or a feature ships. Do not wait for the end of the session.',
    'Track work with `manage_tasks`: add cards and move them across Backlog, Blocked, In Progress, Integration, Testing, and Done. Use `action:"list"` to read the board instead of keeping an ad hoc list.',
    'Repo structure is stored once. Before searching the codebase, call `recall` with action `map`, `paths`, or `search`. Explore the repo only when DeerDawn does not already know the file or symbol.',
    'After exploring, save durable facts with `manage_memory`: `record_paths` for files and folders, `record_finding` for bugs and handoffs, and `upsert_entities` for services, patterns, and decisions.',
    'Use `recall(action:"entities")` for architecture and decisions, `manage_memory(action:"import_local")` on a first local open with no context, and `manage_memory(action:"finish_task", complete_task:true, confirm_complete:true)` when the task is done.',
  ];
}

// With a token, the block a writer puts in a person's file. Without one, the
// legacy markers: what older versions wrote, kept so a test or a reader can
// still build one. Nothing that writes a file calls it without a token.
function buildDeerdawnInstructionBlock(token) {
  const [open, close] = isBlockToken(token) ? [openMarkerFor(token), closeMarkerFor(token)] : [OPEN_MARKER, CLOSE_MARKER];
  return [open, ...buildDeerdawnInstructionLines(), close, ''].join('\n');
}

function buildCursorInstructionBlock(token) {
  const [open, close] = isBlockToken(token) ? [openMarkerFor(token), closeMarkerFor(token)] : [OPEN_MARKER, CLOSE_MARKER];
  return [open, '## DeerDawn', 'Project context is auto-synced below via .cursorrules.', close, ''].join('\n');
}

module.exports = {
  OPEN_MARKER,
  CLOSE_MARKER,
  MARKER_NAME_PREFIX,
  BLOCK_NOTICE,
  isBlockToken,
  openMarkerFor,
  closeMarkerFor,
  ownedMarkersFor,
  buildDeerdawnInstructionLines,
  buildDeerdawnInstructionBlock,
  buildCursorInstructionBlock,
};
