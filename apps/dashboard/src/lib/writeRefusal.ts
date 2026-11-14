import { apiErrorReason, isApiError, WITHHELD_SECTION_LABELS } from '@/lib/api';
import { workspaceInactiveMessage } from '@/lib/workspaceFallback';

/**
 * Turn a refused write into a sentence that says what actually happened.
 *
 * A teammate editing a shared project they may only read gets
 * `share_write_forbidden` from the API, with `blocked_fields` naming the
 * sections and a `message` explaining why. Every dashboard write surface
 * discarded both and showed "Couldn't save that change — rolled back." — which
 * reads as a dropped connection, so the honest answer ("this section is not
 * yours to edit") looked like a glitch worth retrying. Retrying refuses again,
 * forever, and nothing on the screen ever says why.
 *
 * Returns null when the error is NOT a permission refusal, so callers keep
 * their own wording for a genuine save failure — the two must not converge.
 */
export function writeRefusalMessage(error: unknown): string | null {
  // The other refusal that is not a failure: the active team's subscription has
  // lapsed, so a header-less write is refused with 409 rather than quietly
  // landing in the writer's personal workspace. Same rule as below — the server
  // said something true and specific, and a retry cannot change it.
  const inactive = workspaceInactiveMessage(error);
  if (inactive) return inactive;

  const reason = apiErrorReason(error);

  // A REFUSAL THE SERVER EXPLAINED is not a failed save either. The board at its
  // open-card limit answers 409 board_open_limit_reached with a sentence naming
  // how full the board is, which cards were refused and what frees a slot; the
  // board showed "Couldn't save that change — rolled back." over it, so the
  // reader retried a write that cannot succeed until they close a card. The same
  // holds for any 409/422 that carries a code and a sentence: those are the
  // statuses the API uses for "understood, and refused", never for a transient
  // failure (that is 5xx or no response at all).
  if (reason && reason !== 'share_write_forbidden' && isApiError(error)
    && (error.status === 409 || error.status === 422)) {
    const sentence = serverSentence(error, reason);
    return sentence ? `Not saved. ${sentence}` : null;
  }

  if (reason !== 'share_write_forbidden') return null;

  const sections = blockedSectionLabels(error);
  if (sections.length) {
    const named = formatList(sections);
    return `Not saved: ${named} ${sections.length === 1 ? 'is' : 'are'} read-only for you on this shared project. Ask its owner for edit access.`;
  }

  // No blocked_fields: a whole-project or whole-workspace refusal. The server's
  // own sentence is the better explanation (it distinguishes "viewer in this
  // workspace" from "this project is not shared with you"); strip the machine
  // prefix it carries for the MCP clients.
  const fromServer = isApiError(error) ? String(error.message || '') : '';
  const cleaned = fromServer.replace(/^share_write_forbidden:\s*/i, '').trim();
  if (cleaned && cleaned !== 'share_write_forbidden') {
    return `Not saved: ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
  }
  return 'Not saved: you have read-only access to this project.';
}

/**
 * The server's explanation — the body's own `message`, never the client's
 * fallback text — without the machine prefix it carries for MCP clients
 * (`board_open_limit_reached: …`) and without an instruction only an MCP client
 * can follow (`(manage_tasks action "complete" or "remove")`). Null when the
 * server sent no sentence, only a code: then the caller's wording stands.
 * Kept verbatim apart from its first letter, which is raised to start the
 * sentence; lowering it would recase a name the server put first.
 */
function serverSentence(error: unknown, reason: string): string | null {
  if (!isApiError(error)) return null;
  const bodyMessage = error.data?.message;
  const raw = typeof bodyMessage === 'string' ? bodyMessage.trim() : '';
  if (!raw || raw === reason) return null;
  const prefix = new RegExp(`^${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`, 'i');
  // The caller opens with "Not saved.", so the server's own "Nothing was saved."
  // is dropped: a full board read "Not saved. … Nothing was saved. …", the
  // same fact twice in one toast.
  const cleaned = raw
    .replace(prefix, '')
    .replace(/\s*\(manage_tasks[^)]*\)/g, '')
    .replace(/(?:^|\s)(?:nothing was saved|not saved)\.(?=\s|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) return null;
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

/** The refused sections as human labels, in the order the server named them. */
export function blockedSectionLabels(error: unknown): string[] {
  if (!isApiError(error)) return [];
  const raw = (error.data as { blocked_fields?: unknown } | undefined)?.blocked_fields;
  if (!Array.isArray(raw)) return [];
  // Deduped: one section can reach here under two field names (todo_items and
  // completed_todos are one board), and "task board and task board" says it twice.
  return [...new Set(raw
    .map((field) => {
      const key = String(field);
      return WITHHELD_SECTION_LABELS[key] || key.replace(/_/g, ' ').trim();
    })
    .filter(Boolean))];
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The server's sentence for a refused project action (delete, archive, move,
 * rename), without the machine prefix and with its first letter raised, or the
 * message unchanged when it is not one. Journey r6: a colleague's private project
 * is its author's to delete, archive, move or share while they are in the
 * workspace, and only its author or an owner may rename a shared one; the API
 * explains which, and the project manager shows that instead of a bare code.
 */
export function projectActionRefusal(message: string): string {
  const cleaned = String(message || '').replace(/^share_write_forbidden:\s*/i, '').trim();
  if (!cleaned || cleaned === String(message || '').trim()) return String(message || '');
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}
