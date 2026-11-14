/**
 * A REMOVED MEMBER'S OPEN TAB RELOADS INTO THEIR OWN WORKSPACE, AND SAYS WHY.
 *
 * Journey r4: a person was removed from a team while a dashboard tab showed it.
 * The tab's next background read was refused (403 workspace_forbidden); the API
 * client dropped the workspace and replayed the read in the person's own
 * workspace, silently. The shell still said TEAM, and the next thing the person
 * saved landed in their personal workspace under that badge, which round 3's
 * rule forbids: a tab writes where it shows.
 *
 * The owner's decision: when ANY request is refused because the person is no
 * longer a member, the tab reloads into their own workspace and tells them they
 * were removed from the team. From the refusal to the reload nothing is written
 * anywhere. The legacy member whose own org IS the team that refused them is a
 * different case with its own screen (WorkspaceForbiddenExit): reloading cannot
 * help them, so it is left exactly as it was. So is the lapsed-subscription
 * fallback, which is not a refusal of membership at all.
 *
 * Browser storage is per viewer and may be unavailable: every access is
 * guarded, and without it the tab still stops writing and still reloads; only
 * the sentence after the reload is lost.
 */
import type { WorkspaceSummary } from './api';

const NOTICE_KEY = 'deerdawn.removedFromWorkspace';
/** The same refusal within this window does not reload the tab a second time. */
export const REMOVAL_RELOAD_GUARD_MS = 60_000;

export interface RemovalNotice {
  workspace: string;
  name: string | null;
  at: number;
  /** Shown once after the reload; kept (not deleted) as the reload guard. */
  shown?: boolean;
}

// Names of workspaces this tab has been shown, so the sentence after the reload
// can name the team. After the removal the listing no longer carries it.
const knownNames = new Map<string, string>();

export function rememberWorkspaceNames(workspaces: WorkspaceSummary[] | null | undefined): void {
  for (const entry of workspaces || []) {
    if (entry && entry.workspace && typeof entry.name === 'string' && entry.name.trim()) {
      knownNames.set(entry.workspace, entry.name.trim());
    }
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readNotice(): RemovalNotice | null {
  try {
    const raw = sessionStore()?.getItem(NOTICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemovalNotice;
    return parsed && typeof parsed.workspace === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ── The tab stops writing from the refusal to the reload ────────────────────

let leaving = false;

/** True between a membership refusal and the reload it causes. */
export function isLeavingRemovedWorkspace(): boolean {
  return leaving;
}

/**
 * The server refused `refused` because this person is no longer a member.
 * `personal` is the person's own workspace, when the tab knows it. Returns
 * whether the tab should reload into its own workspace: false for the legacy
 * member whose own workspace is the one refusing them (their screen handles
 * it), and false when this same refusal already reloaded the tab a moment ago.
 */
export function noteRemovedFromWorkspace(refused: string | null | undefined, personal: string | null | undefined, now: number = Date.now()): boolean {
  if (!refused) return false;
  if (personal && refused === personal) return false;
  const previous = readNotice();
  // Already reloaded for this refusal a moment ago: the reload did not move the
  // tab off it, so another would only loop. Behave as before this change.
  if (previous && previous.workspace === refused && now - previous.at < REMOVAL_RELOAD_GUARD_MS) return false;
  // Only a page that CAN reload is "leaving": a host with no reload (tests,
  // server rendering) would otherwise stop writing for good.
  if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') return false;
  leaving = true;
  try {
    sessionStore()?.setItem(NOTICE_KEY, JSON.stringify({ workspace: refused, name: knownNames.get(refused) || null, at: now }));
  } catch {
    /* the reload still happens; only the sentence after it is lost */
  }
  return true;
}

/**
 * The sentence for a tab that has just reloaded after a removal, once. Marks it
 * shown (keeping the reload guard) rather than deleting it, so a second refusal
 * of the same workspace in the next minute does not reload again.
 */
// Taken once per page load, and the same answer for the rest of it: React runs
// a mount effect twice in development, and a second take must not come back
// empty and hide the sentence.
let takenThisPage: { notice: RemovalNotice | null } | null = null;

export function takeRemovalNotice(): RemovalNotice | null {
  if (takenThisPage) return takenThisPage.notice;
  const notice = readNotice();
  takenThisPage = { notice: notice && !notice.shown ? notice : null };
  if (!notice || notice.shown) return null;
  try {
    sessionStore()?.setItem(NOTICE_KEY, JSON.stringify({ ...notice, shown: true }));
  } catch {
    /* shown once either way: the component keeps it in state */
  }
  return notice;
}

/** What the person reads after the reload. */
export function removalNoticeText(notice: RemovalNotice): string {
  const who = notice.name ? `You are no longer a member of ${notice.name}.` : 'You are no longer a member of that workspace.';
  return `${who} A workspace owner removed you, or the workspace was closed. This tab has reloaded into your own workspace.`;
}

// ── What leaving, or being removed, leaves behind: said BEFORE it happens ─────
//
// Journey r5 (round 2's BLOCKED 14): what somebody wrote into a team's shared
// project stays with the team when they go. Removal sets removed_at and nothing
// else; only the person's personal projects and their profile move to their own
// workspace. The confirmations said "everything you contributed stays here" and
// nothing about what that meant, so the first anyone knew that a decision or a
// board card was no longer theirs to take back was after they had left. Both
// screens now say, in the same two parts the delete-account dialog uses (what
// stays with the team, what goes with the person), what each covers.
//
// The deletion sentence is the API's own rule, exactly (holdsAuthorRights in
// contextSyncService): the project's author can delete it, and a workspace owner
// once the author has left; while the author is a member and has made a section
// view-only, only the author can. So it is said as a fact, not a hope.

const NOTE_KINDS = 'decisions, open questions, board cards, lines of context and entities';

/** The text of the leave confirmation (the person removing themselves). */
export function leaveWorkspaceConfirmText(): string {
  return 'Leave this workspace?\n\n'
    + `Stays with the team: everything you wrote into its shared projects, such as ${NOTE_KINDS}. `
    + 'It stays credited to you. You cannot change it after you leave. The project\u2019s author can delete it, and so can a workspace owner once the author has left.\n\n'
    + 'Goes with you: your personal projects and your profile in it move to your own workspace '
    + '(a profile you already have there is kept, with this one added to it). '
    + 'Your API keys for this workspace are revoked now, and public share links you made on its projects are turned off.\n\n'
    + 'Nothing in any other workspace changes.';
}

/** The text of an owner's confirmation before removing somebody else. */
export function removeMemberConfirmText(label: string): string {
  return `Remove ${label} from this workspace?\n\n`
    + `Stays with the team: everything they wrote into its shared projects, such as ${NOTE_KINDS}. `
    + 'It stays credited to them. A workspace owner can delete it once the project\u2019s author has left; until then its author can.\n\n'
    + 'Goes with them: their personal projects and their profile in it move to their own workspace. '
    + 'Their API keys for this workspace are revoked now, and public share links they made on its projects are turned off.';
}
