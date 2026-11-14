/**
 * A team workspace is created BY PAYING FOR IT (journey r6).
 *
 * The new-team wizard used to create an empty Free workspace at its first step, so
 * every abandoned checkout left one behind. It now sends the name to a Team
 * checkout and creates nothing: the workspace appears when Stripe confirms the
 * subscription, and the wizard picks up from there. These are the two decisions
 * that resume needs, kept out of the page so they can be tested.
 */

/** What the wizard was opened with. */
export interface NewTeamArrival {
  /** Back from Stripe with a paid checkout: wait for the workspace, then continue. */
  resume: boolean;
  /** The key the workspace will have (or has). Not an authority: only a listing that includes it counts. */
  workspace: string | null;
  /** Back from Stripe without paying. Nothing was created. */
  canceled: boolean;
}

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v ? v : null;
}

export function readNewTeamArrival(query: Record<string, string | string[] | undefined>): NewTeamArrival {
  const workspace = first(query.workspace);
  return {
    resume: first(query.resume) === '1' && Boolean(workspace) && (workspace as string).length <= 200,
    workspace: workspace && workspace.length <= 200 ? workspace : null,
    canceled: first(query.canceled) === 'true',
  };
}

/**
 * The workspace the checkout created, once the person's own listing includes it.
 * Owner only: the buyer is its owner, and a listing entry that says otherwise is
 * not this checkout's workspace.
 */
export function createdWorkspace(
  listing: { workspaces?: Array<{ workspace: string; name: string; role: string }> } | null | undefined,
  key: string | null,
): { workspace: string; name: string } | null {
  if (!key) return null;
  const found = (listing?.workspaces || []).find((w) => w.workspace === key && w.role === 'owner');
  return found ? { workspace: found.workspace, name: found.name } : null;
}

/** How long the wizard waits for the webhook, and how often it looks. */
export const WORKSPACE_WAIT_MS = 90_000;
export const WORKSPACE_POLL_MS = 2_000;

export const CHECKOUT_CANCELED_MESSAGE = 'Checkout was canceled, so nothing was created and you were not charged.';
export const WORKSPACE_LATE_MESSAGE = 'Your payment went through, and the workspace is still being set up. '
  + 'It will appear in the workspace switcher shortly. Reload this page in a minute to continue.';
