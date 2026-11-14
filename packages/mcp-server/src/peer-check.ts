/**
 * peer-check — the PreToolUse hook body.
 *
 * Fires before every Edit/Write in the agent's main loop. This is the only place
 * in the product where a warning arrives in time to PREVENT a collision rather
 * than explain one afterwards — and the most latency-sensitive place we could
 * possibly put code. Two rules follow from that, and neither is negotiable:
 *
 *   1. NO NETWORK, EVER. Everything comes from ~/.deerdawn/peers.json, refreshed
 *      as a side effect of calls the agent already makes. Same rationale as
 *      surface-state.ts: a token cost is preferable to a latency cost, and a
 *      latency cost per EDIT is worse than one per session.
 *   2. FAIL OPEN, ALWAYS. Every path returns "no warning" on any problem. The
 *      hook never emits a deny decision — not for an overlap, not for a parse
 *      error. Blocking a legitimate edit is how this feature gets uninstalled,
 *      and then it protects nobody.
 *
 * Output is Claude Code's PreToolUse hook JSON. Silence (empty output) is the
 * overwhelmingly common case and costs the agent nothing.
 */

import { readPeerMirror, findOverlappingPeers } from './peer-mirror.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    // Shorter than the capture hooks': this one sits in front of every edit, so a
    // stalled read must give up fast and let the edit through.
    const timeoutHandle = setTimeout(() => resolve(''), 200);
    if (typeof (timeoutHandle as any).unref === 'function') (timeoutHandle as any).unref();
  });
}

/** The path this tool call is about to write, if we can tell. */
function extractTargetPath(payload: any): string | null {
  const input = payload?.tool_input || payload?.toolInput || {};
  const candidate = input.file_path || input.filePath || input.path || input.notebook_path;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

// What a peer contributes to the warning is text SOMEBODY ELSE wrote — a display
// name from the roster, a card title from the board — and additionalContext puts
// it straight into this agent's context on every edit. Unclipped, a teammate's
// 4,000-character card title (or one written as a paragraph of instructions) was
// injected whole, once per Edit. A name is a name and a title is a title: one
// line each, short, and a bounded number of them.
const MAX_PEER_NAME_CHARS = 60;
const MAX_CARD_TITLE_CHARS = 80;
const MAX_PEERS_NAMED = 3;

function clipForContext(value: unknown, max: number): string {
  // Control characters and line breaks first: a newline is what lets quoted text
  // stop looking quoted.
  // eslint-disable-next-line no-control-regex
  const oneLine = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/** The PreToolUse hook output for this payload, or null for silence. */
export function buildPeerWarning(payload: any): Record<string, unknown> | null {
  const target = extractTargetPath(payload);
  if (!target) return null;

  const cwd = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const peers = readPeerMirror(String(cwd));
  if (!peers.length) return null;

  const overlapping = findOverlappingPeers(target, peers);
  if (!overlapping.length) return null;

  // Name the person where the server could name them. A collision warning that
  // says "sess_a1b2 has written here" is true and unusable; one that says
  // "sarah@acme.com has" is a warning the reader can act on — go and ask her.
  // Falls back to the session id rather than to nothing, because an unnamed
  // peer is still a peer.
  const named = overlapping.slice(0, MAX_PEERS_NAMED).map((p) => {
    const title = clipForContext(p.held_cards?.[0], MAX_CARD_TITLE_CHARS);
    const name = clipForContext(p.display_name, MAX_PEER_NAME_CHARS) || clipForContext(p.session_id, MAX_PEER_NAME_CHARS);
    return `${name}${title ? ` on "${title}"` : ''}`;
  });
  const unnamed = overlapping.length - named.length;
  const who = named.join(', ') + (unnamed > 0 ? `, and ${unnamed} more` : '');

  // additionalContext, never permissionDecision. The model is told and decides;
  // the edit is not stopped (rule 2, and the advisory-over-enforcing rule the
  // whole design rests on).
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `[DeerDawn] Another agent has recently written in this area: ${who}. `
        + 'Your edit is not blocked — but check for overlapping work before assuming this file is yours.',
    },
  };
}

export async function runPeerCheck(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;

    let payload: any;
    try { payload = JSON.parse(raw); } catch { return; }

    const warning = buildPeerWarning(payload);
    if (warning) process.stdout.write(JSON.stringify(warning));
  } catch {
    // Fail open. A hook that throws in the edit path is strictly worse than a
    // hook that says nothing.
  }
}
