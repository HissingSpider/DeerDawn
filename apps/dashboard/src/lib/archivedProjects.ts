/**
 * NOTHING ACTIVE IS NOT NOTHING.
 *
 * The nightly job archives a project after 30 idle days, and archived projects
 * leave every listing. So a person who came back after five weeks with two
 * projects opened Today to "Nothing to pick up yet. Once a tool is connected
 * ..." and Projects to "right now there's nothing saved for it to return.
 * Import your project context" — while both projects sat intact one click
 * away, behind "Manage projects".
 *
 * The hosted tool already says this well (shared-context
 * formatArchivedProjectsNotice: "N archived projects are waiting, not gone").
 * The dashboard says the same thing, and the rule behind it only in the words
 * the dashboard already uses for it (ProjectManager's archived list).
 *
 * Pure so the copy is testable without React. Every sentence is built here as
 * one string: JSX drops the space after an expression, so "{n} archived"
 * written in markup is how "2archived" reaches a screen.
 */

export interface ArchivedProjectLike {
  project_id: string;
  project_name: string;
}

export interface ArchivedProjectsCopy {
  headline: string;
  /** The names, as one line, for more than one project; null for one (the
   *  headline already names it). */
  names: string | null;
  body: string;
  actionLabel: string;
}

/** Names shown before "and N more", the same cap as the hosted notice. */
export const ARCHIVED_NAMES_SHOWN = 5;

/** The dashboard's own sentence for the rule (ProjectManager's archived list). */
export const AUTO_ARCHIVE_RULE = 'Projects idle for 30 days are archived automatically.';

/** Where projects are restored from: the manager on /projects, opened on arrival. */
export const RESTORE_ROUTE = '/projects?manage=archived';

function displayName(project: ArchivedProjectLike): string {
  const name = typeof project?.project_name === 'string' ? project.project_name.trim() : '';
  return name || 'Untitled project';
}

/**
 * What to say when there is nothing active but there IS something archived.
 * Null when nothing is archived either: that account is genuinely new, and its
 * empty state is not this one's business.
 */
export function archivedProjectsCopy(archived: ArchivedProjectLike[] | null | undefined): ArchivedProjectsCopy | null {
  const list = Array.isArray(archived) ? archived.filter(Boolean) : [];
  if (list.length === 0) return null;

  if (list.length === 1) {
    return {
      headline: `“${displayName(list[0])}” is archived, not gone.`,
      names: null,
      body: `Nothing is active right now. ${AUTO_ARCHIVE_RULE} Everything it remembered is still there.`,
      actionLabel: 'Restore it',
    };
  }

  const shown = list.slice(0, ARCHIVED_NAMES_SHOWN).map(displayName);
  const more = list.length - shown.length;
  return {
    headline: `${list.length} archived projects are waiting, not gone.`,
    names: more > 0 ? `${shown.join(' · ')} and ${more} more` : shown.join(' · '),
    body: `Nothing is active right now. ${AUTO_ARCHIVE_RULE} Everything they remembered is still there.`,
    actionLabel: 'Restore a project',
  };
}
