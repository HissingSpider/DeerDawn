/**
 * Joining a workspace through an approved email domain (the "Join <name>"
 * offer in the workspace switcher).
 *
 * THE BUG. The switcher's handler ended in `.finally(() => reload())` and never
 * read the error. A full team (402 limit_exceeded), a plan without team
 * features (upgrade_required), a person the owner had removed (403
 * removed_from_workspace), an offer withdrawn since the page loaded (403
 * not_joinable) and a refusal about the workspace this browser was bound to
 * (409 workspace_inactive and friends) all reloaded the page with the offer
 * still sitting there. Pressing it again did the same thing, and nothing ever
 * said why.
 *
 * The outcome is decided here, apart from the component, so every branch is
 * testable: enter the workspace only on success (the same two halves as an
 * invitation: this browser's stored choice AND the server's active workspace,
 * which is what header-less agent sessions read), and otherwise say what
 * happened in a sentence the reader can act on.
 */
import {
  api,
  apiErrorReason,
  isApiError,
  setActiveWorkspace,
} from './api';
import { logger } from './logger';

export type JoinOffer = { workspace: string; name: string };

export type DomainJoinOutcome =
  | { ok: true; workspace: string }
  | {
    ok: false;
    reason: string | undefined;
    message: string;
    /** The offer cannot succeed again from this page (withdrawn, or the
     *  reader was removed): hide the button rather than invite a second try. */
    dropOffer: boolean;
  };

/**
 * Refusals about the workspace the request was BOUND to, not the one being
 * joined. Same set, and same cure, as an invitation's (lib/pendingInvite).
 */
const BOUND_WORKSPACE_REFUSALS = new Set([
  'subscription_inactive',
  'past_due',
  'workspace_inactive',
  'lockdown_active',
  'workspace_forbidden',
]);

const TERMINAL_REFUSALS = new Set(['not_joinable', 'removed_from_workspace']);

function label(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || 'that workspace';
}

/**
 * What to tell the reader when a domain join was refused.
 *
 * Mapped per code rather than echoing the server by default: the seat and plan
 * refusals are written for the workspace's OWNER ("Upgrade to add more"), and
 * the person joining cannot upgrade somebody else's plan. The server's own
 * sentence is used where it is written for this reader (removal) and for any
 * code this page does not know yet.
 */
export function domainJoinFailureMessage(
  reason: string | undefined,
  workspaceName: string | null | undefined,
  serverMessage?: string,
): string {
  const name = label(workspaceName);
  if (reason && BOUND_WORKSPACE_REFUSALS.has(reason)) {
    return `The workspace you are currently using blocked this, not ${name}. Switch to your own workspace above and try again.`;
  }
  switch (reason) {
    case 'limit_exceeded':
      return `${name} has no free seats right now. Ask one of its owners to add a seat, then try again.`;
    case 'upgrade_required':
      return `${name} is not on a plan that includes team members right now. Ask one of its owners about it.`;
    case 'removed_from_workspace':
      return serverMessage || `You were removed from ${name}. Ask one of its owners to invite you again.`;
    case 'not_joinable':
      return `${name} is no longer open to your email domain. Ask one of its owners for an invitation.`;
    default:
      return serverMessage || `Could not join ${name}. Try again in a moment.`;
  }
}

type Deps = {
  accept: (workspaceKey: string) => Promise<{ workspace?: string } | null | undefined>;
  setBrowserWorkspace: (workspace: string | null) => void;
  setServerWorkspace: (workspace: string | null) => Promise<unknown>;
};

const defaultDeps: Deps = {
  accept: (key) => api.acceptJoinableWorkspace(key),
  setBrowserWorkspace: setActiveWorkspace,
  setServerWorkspace: (workspace) => api.setActiveWorkspaceOnServer(workspace),
};

/** Accept a domain offer, and enter the workspace only if the accept succeeded. */
export async function joinWorkspaceByDomain(offer: JoinOffer, deps: Deps = defaultDeps): Promise<DomainJoinOutcome> {
  let result: { workspace?: string } | null | undefined;
  try {
    result = await deps.accept(offer.workspace);
  } catch (err) {
    const reason = apiErrorReason(err);
    const serverMessage = isApiError(err) && typeof err.data?.message === 'string' && err.data.message.trim()
      ? err.data.message.trim()
      : undefined;
    return {
      ok: false,
      reason,
      message: domainJoinFailureMessage(reason, offer.name, serverMessage),
      dropOffer: Boolean(reason && TERMINAL_REFUSALS.has(reason)),
    };
  }
  const joined = typeof result?.workspace === 'string' && result.workspace ? result.workspace : offer.workspace;
  deps.setBrowserWorkspace(joined);
  // Best-effort, as it is for an invitation: the dashboard switches either way
  // (the header carries it), and the agent keeps its previous workspace until
  // the switcher is used.
  await deps.setServerWorkspace(joined).catch((err) => {
    logger.error('Failed to activate the domain-joined workspace on the server', err);
  });
  return { ok: true, workspace: joined };
}

/** The offer button's label. One expression, so JSX has no seam to drop a space in. */
export function domainJoinLabel(offer: JoinOffer, joining: boolean): string {
  return joining
    ? `Joining ${label(offer.name)}…`
    : `Join ${label(offer.name)}: your email domain is approved`;
}
