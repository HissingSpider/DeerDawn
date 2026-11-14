import type { ProjectSharing, TeamMember } from './api';

/**
 * Projects whose author cannot be identified (journey r7), for the project
 * manager. The server marks them `author_unknown` for workspace owners only, so
 * anybody else gets an empty set and sees nothing new.
 */
export function unknownAuthorIds(rows: ProjectSharing[] | null | undefined): Set<string> {
  return new Set((rows || []).filter((row) => row.author_unknown === true).map((row) => row.project_id));
}

/** Who an owner may pick: ACTIVE owners and members (a viewer cannot be an author), the owner themselves included. */
export function assignableMembers(members: TeamMember[] | null | undefined): TeamMember[] {
  return (members || []).filter((member) => member.status === 'active' && member.removed_at === null && member.role !== 'viewer');
}
