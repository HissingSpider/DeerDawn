import type { WorkspaceSummary } from './api';

/**
 * WHERE DOES SOMEBODY GO WHEN THE WORKSPACE REFUSES THEM?
 *
 * `workspace_forbidden` used to be a screen with one button on it: Retry. That
 * works for the case it was written for — a stored workspace choice the person
 * was removed from — because the API client drops the stale choice and the
 * retry lands in their personal workspace.
 *
 * It dead-ends for the LEGACY member whose users.org_id IS the team. The legacy
 * invite path created people directly inside the target org, so their "personal"
 * workspace and the workspace that just refused them are the same row. Clearing
 * the stored choice changes nothing: the account default resolves to the same
 * forbidden key, every retry 403s again, and Retry is a button that cannot
 * succeed. Signing out is not an exit either unless it is said out loud — they
 * are still signed in, /login sees a live session and sends them back.
 *
 * So the screen has to answer a question instead of offering a loop: which
 * workspaces may this person actually enter? That is what
 * GET /api/v1/teams/workspaces exists to say, and it is deliberately reachable
 * while barred for exactly this reason.
 */
export type ForbiddenWorkspaceExit =
  /** They belong somewhere else — offer it, one click. */
  | { kind: 'switch'; options: WorkspaceSummary[] }
  /**
   * There is nowhere to switch to. `home_org_is_forbidden` is the legacy case
   * (their only workspace is the one that refused them); `lookup_failed` is when
   * we could not even ask. Both end the same way — say so plainly and sign out —
   * but they are different facts and the copy should not pretend otherwise.
   */
  | { kind: 'sign_out'; reason: 'home_org_is_forbidden' | 'lookup_failed' };

/**
 * `listing` is the GET /teams/workspaces payload, or null when that call itself
 * failed (it is the one route a barred member can still reach, but a network
 * error or an older API is always possible).
 *
 * A workspace is only an exit if it is NOT the one that just refused us. The
 * server reports that as `active`, and the account's own org is `personal:
 * true` — for the legacy member those are the same entry, which is precisely why
 * both are excluded rather than just one.
 */
export function planForbiddenWorkspaceExit(
  listing: { active?: string | null; workspaces?: WorkspaceSummary[] } | null
): ForbiddenWorkspaceExit {
  if (!listing || !Array.isArray(listing.workspaces)) {
    return { kind: 'sign_out', reason: 'lookup_failed' };
  }
  const options = listing.workspaces.filter(
    (entry) => entry && entry.workspace && !entry.personal && entry.workspace !== listing.active
  );
  if (options.length) return { kind: 'switch', options };
  return { kind: 'sign_out', reason: 'home_org_is_forbidden' };
}

/**
 * What the screen says. Kept beside the planner so the two cannot drift, and
 * kept plain: the reader's account is fine, this workspace is not theirs any
 * more, and here is the thing that will actually work.
 */
export function forbiddenWorkspaceCopy(exit: ForbiddenWorkspaceExit): {
  description: string;
  actionLabel: string;
} {
  if (exit.kind === 'switch') {
    return {
      description:
        'A workspace owner removed you, or the workspace was closed. Your own account is unaffected — switch to a workspace you still belong to.',
      actionLabel: 'Switch workspace',
    };
  }
  if (exit.reason === 'lookup_failed') {
    return {
      description:
        'A workspace owner removed you, or the workspace was closed, and we could not reach the list of workspaces you can still open. Retry once; if it keeps failing, sign out and back in.',
      actionLabel: 'Sign out',
    };
  }
  return {
    description:
      'A workspace owner removed you, and this account has no other workspace to fall back to — your sign-in is tied to this one. Retrying cannot fix that. Ask an owner to invite you back, or sign out and use a different account.',
    actionLabel: 'Sign out',
  };
}

/**
 * MAY A `workspace_forbidden` REQUEST BE SENT AGAIN WITHOUT ITS WORKSPACE?
 *
 * The API client answers 403 `workspace_forbidden` by dropping the stored
 * workspace and replaying the request. For a READ that is exactly right: a
 * removed member's stale tab re-reads against their own workspace and the
 * bootstrap stops reading the 403 as an expired session.
 *
 * It replayed WHATEVER THE METHOD WAS. So a removed member with a tab still
 * open who created a project, minted an API key, or posted /billing/checkout
 * had that write silently re-aimed at their PERSONAL workspace and succeed
 * there — while the page around them still showed the team. A key that should
 * not exist, a project filed in the wrong place, or a charge against the wrong
 * account, all reported as success.
 *
 * Replaying a read is idempotent. Replaying a write is a second, different
 * write, aimed somewhere the caller did not choose.
 */
export function shouldReplayAfterWorkspaceForbidden(method: string | null | undefined): boolean {
  const verb = String(method || 'GET').toUpperCase();
  return verb === 'GET' || verb === 'HEAD';
}

/** What a refused WRITE says. It has to promise the one thing the caller cannot
 *  otherwise know: nothing was written, anywhere. */
export const WORKSPACE_FORBIDDEN_WRITE_MESSAGE =
  'You no longer have access to that workspace. Nothing was changed.';
