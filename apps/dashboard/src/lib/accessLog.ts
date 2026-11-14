/**
 * The access log's one-line description, by the reader's role.
 *
 * GET /context/audit filters a shared workspace's log to the projects the reader
 * can read (plus their own activity and workspace-wide events such as membership
 * changes). The page still told a member or viewer it listed "Every read, write
 * and export of this workspace's context", which is exactly the claim an access
 * log must not overstate: a reader checking whether anyone opened a project would
 * take the silence about projects they cannot see as "nobody did".
 */
export function accessLogDescription(role: string | null | undefined): string {
  const normalised = (role || '').toLowerCase();
  if (normalised === 'member' || normalised === 'viewer') {
    return 'Reads, writes and exports of the projects you can see in this workspace, your own activity, and every change to who is in it.';
  }
  return "Every read, write and export of this workspace's context, and every change to who is in it.";
}
