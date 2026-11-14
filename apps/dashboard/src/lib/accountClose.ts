/**
 * What closing the account took with it, in words.
 *
 * DELETE /api/v1/orgs closes every other workspace the person was the only one
 * left in, cancels its subscription, and names each one in `closed_workspaces`
 * — "because the person may not remember it existed". The dialog passed on
 * only `export_emailed`, so nobody was ever told (scan 28). This is the sentence
 * the confirmation shows; null when nothing else closed.
 */
export type ClosedWorkspace = { workspace: string; name: string | null };

export function describeClosedWorkspaces(closed: ClosedWorkspace[] | null | undefined): string | null {
  const names = (Array.isArray(closed) ? closed : [])
    .filter((ws) => ws && (ws.name || ws.workspace))
    .map((ws) => `“${(ws.name || '').trim() || ws.workspace}”`);
  if (!names.length) return null;
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return names.length === 1
    ? `${list} closed with your account, because nobody else was in it. Its subscription was cancelled.`
    : `${list} closed with your account, because nobody else was in them. Their subscriptions were cancelled.`;
}

/**
 * What stays behind, said BEFORE the account is deleted.
 *
 * The delete dialog said "permanently deletes your account and all synced
 * context across every project", while the shared and private projects the
 * person worked on inside a team stay with that team. Only the deletion email
 * said so, afterwards (apps/api orgs.js contextExportEmailHtml: "that
 * workspace's shared and private projects stay with it"). The dialog now says
 * it first, in the email's words, naming each team: the non-personal entries of
 * GET /teams/workspaces. Null for somebody in no team.
 */
export function describeTeamWorkThatStays(
  workspaces: Array<{ workspace: string; name?: string | null; personal?: boolean }> | null | undefined,
): string | null {
  const teams = (Array.isArray(workspaces) ? workspaces : [])
    .filter((ws) => ws && ws.workspace && !ws.personal)
    .map((ws) => (ws.name || '').trim() || ws.workspace);
  if (!teams.length) return null;
  if (teams.length === 1) return `${teams[0]}’s shared and private projects stay with it.`;
  const list = `${teams.slice(0, -1).join(', ')} and ${teams[teams.length - 1]}`;
  return `The shared and private projects of ${list} stay with them.`;
}

/**
 * The export line of the delete dialog. The emailed export carries every
 * workspace that closes with the account (journey r5), so the line says so
 * before the person ticks it.
 */
export const EXPORT_ALSO_CLOSED_WORKSPACES = 'It also includes any other workspace that closes with your account.';

/**
 * A failed export stops the deletion (journey r5): DELETE /api/v1/orgs answers
 * 502 `export_not_sent` when the export was asked for and was not emailed, and
 * nothing is deleted. The sentence the dialog shows, from the server's own
 * message when it has one; null for any other failure.
 */
export function exportNotSentNotice(reason: string | null | undefined, message?: string | null): string | null {
  if (reason !== 'export_not_sent') return null;
  return (message || '').trim()
    || 'Your export could not be emailed, so nothing was deleted. Try again, or turn off the export option to delete without one.';
}
