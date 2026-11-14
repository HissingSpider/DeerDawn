/**
 * Copy for the owner's view of the AI tools a colleague connected to the team
 * workspace (Settings -> Team). Kept out of the page so what the confirmation
 * promises can be pinned by a test: it must say what disconnecting does, and
 * what it leaves alone.
 */

export interface TeamConnectionLike {
  client_name: string | null;
  person: { user_id: string; display_name: string };
  own?: boolean;
}

/** The tool's name as the owner should read it; never blank. */
export function connectionToolName(connection: Pick<TeamConnectionLike, 'client_name'>): string {
  return connection.client_name?.trim() || 'An unnamed app';
}

/** Whose it is: "You" for the owner's own, otherwise the person's name. */
export function connectionPersonName(connection: TeamConnectionLike): string {
  return connection.own ? 'You' : connection.person.display_name;
}

/** The question asked before a connection is cut off. */
export function disconnectConfirmation(connection: TeamConnectionLike): string {
  const tool = connection.client_name?.trim() || 'unnamed app';
  const who = connection.own ? 'your' : `${connection.person.display_name}'s`;
  return (
    `Disconnect ${who} ${tool} from this workspace?\n\n`
    + 'It stops working right away and cannot renew its access.\n'
    + 'Nothing in the workspace is deleted.\n'
    + (connection.own
      ? 'You can connect it again from Setup.'
      : `${connection.person.display_name} can connect it again.`)
  );
}

export const TEAM_CONNECTIONS_INTRO =
  'AI tools people on this team connected to this workspace. A connection works only in the workspace it was '
  + 'approved for, so switching workspaces does not move it; to use a tool in another workspace, approve it there.';

export const TEAM_CONNECTIONS_EMPTY = 'No connected AI tools are listed yet.';
