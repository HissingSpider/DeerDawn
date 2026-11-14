/**
 * Which workspace a connection will be pinned to, named on the consent screen.
 *
 * A hosted connection acts only in the workspace it is approved from, for good:
 * switching workspace later moves nothing. So the screen that approves it has to
 * say where it will work. The API binds an approval to the workspace this
 * request is served from, which /api/v1/teams/workspaces reports as `active`
 * (and `fallback.to` when a lapsed team is being served from the person's own
 * workspace instead).
 */

export interface ConsentWorkspaceListing {
  active?: string | null;
  fallback?: { to?: string | null } | null;
  workspaces?: Array<{ workspace: string; name: string; personal: boolean }>;
}

export interface ConsentWorkspace {
  name: string;
  personal: boolean;
}

/** The workspace an approval made now would be pinned to, or null when it cannot be told. */
export function consentWorkspace(listing: ConsentWorkspaceListing | null | undefined): ConsentWorkspace | null {
  if (!listing || !Array.isArray(listing.workspaces)) return null;
  const target = listing.fallback?.to || listing.active;
  if (!target) return null;
  const entry = listing.workspaces.find((candidate) => candidate.workspace === target);
  if (!entry) return null;
  return { name: entry.personal ? 'your personal workspace' : entry.name, personal: entry.personal };
}
