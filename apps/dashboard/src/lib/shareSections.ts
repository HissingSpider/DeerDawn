/**
 * What a shared project can share, in the words an author would use.
 *
 * Sharing has ONE switch — the project's visibility — and a share row only
 * NARROWS which sections travel. This module is the narrowing, on the dashboard
 * side, and the rule it has to keep is the one written where
 * DEFAULT_SHARED_SECTIONS is defined in the API:
 *
 *   - a project with no saved rows travels today's DEFAULTS, whatever they are;
 *   - a project with saved rows travels exactly what its author chose, and a
 *     default added later is never backfilled onto it.
 *
 * Which is precisely why the panel has to OFFER every section, the task board
 * included. An author whose configuration predates a new default keeps what they
 * chose — correct — but they can only change their mind if the screen lets them,
 * and until this existed the dashboard could set visibility and nothing else.
 */

export interface ShareSectionRow {
  section_key: string;
  can_view: boolean;
  can_edit: boolean;
}

/**
 * Human labels. The key list itself comes from the API (`section_allowlist`), so
 * a section this file has no label for still renders — under its key — rather
 * than silently disappearing from a screen that is supposed to be the complete
 * list of what travels.
 */
export const SHARE_SECTION_LABELS: Record<string, string> = {
  description: 'Description',
  current_task: 'Current task',
  current_status: 'Status',
  goals: 'Goals',
  open_questions: 'Open questions',
  recent_decisions: 'Decisions',
  tech_stack: 'Tech stack',
  file_structure_summary: 'File structure',
  blocking_issue: 'Blockers',
  task_progress: 'Task progress',
  recurring_context: 'Recurring context',
  source_summary: 'Source summary',
  hot_paths: 'Known paths',
  entrypoints: 'Entrypoints',
  surfaces: 'Surfaces',
  debugging_notes: 'Debugging notes',
  // One key, two stored fields: the Done column (`completed_todos`) answers to
  // this same section, so the label says board and not "to-dos".
  todo_items: 'Task board',
};

/** A section nobody has labelled is shown by key, never dropped. */
export function sectionLabel(sectionKey: string): string {
  return SHARE_SECTION_LABELS[sectionKey] || sectionKey;
}

/**
 * The sections to offer, and in what order. Server-supplied allowlist first
 * (it is the only list that can actually be saved), falling back to the labelled
 * ones so the panel is never empty against an older API.
 */
export function offeredSections(allowlist?: string[] | null): string[] {
  const keys = (allowlist || []).filter(Boolean);
  return keys.length ? keys : Object.keys(SHARE_SECTION_LABELS);
}

/**
 * Reading and writing are two permissions, and the panel shows both.
 */
export interface SharePermissions {
  /** Sections a teammate may READ. */
  view: Iterable<string>;
  /** Sections a teammate may WRITE. Only meaningful where `view` allows it. */
  edit: Iterable<string>;
}

/**
 * WHAT THIS PROJECT GRANTS RIGHT NOW — the state the picker opens on, and the
 * state an untouched save has to reproduce exactly.
 *
 * Getting the no-rows case wrong is how the first save became a downgrade. An
 * unconfigured share does not merely SHOW the defaults, it grants the write on
 * all of them: canEditSectionForActor's fallback for a section with no stored
 * row is `DEFAULT_SHARED_SECTIONS.includes(sectionKey)`, true for every default
 * including `recent_decisions`. A panel that rendered those four as ticked and
 * then wrote `can_edit: false` for the decision log took away a permission it
 * never displayed — a picker that silently downgrades what it displays is the
 * same class of bug as a toggle that enforces nothing.
 *
 * With stored rows there is nothing to infer: they say what they say, minus any
 * edit flag on a section nobody can read.
 */
export function effectivePermissions(
  saved: ShareSectionRow[] | undefined,
  defaults: string[],
): { view: string[]; edit: string[] } {
  const rows = saved || [];
  if (!rows.length) return { view: [...defaults], edit: [...defaults] };
  return {
    view: rows.filter((row) => row.can_view).map((row) => row.section_key),
    edit: rows.filter((row) => row.can_view && row.can_edit).map((row) => row.section_key),
  };
}

/**
 * The rows to SAVE for a set of permissions.
 *
 * A row is written for every offered section, including the unshared ones with
 * `can_view: false`, rather than only for the shared ones. Two reasons, both
 * sharp edges:
 *
 *   - PATCH /projects/:id/sharing writes the DEFAULT rows when it receives an
 *     explicit empty sections array, so a shared-only payload would publish all
 *     four defaults at the exact moment somebody turned everything off — the
 *     loudest possible way to get this wrong;
 *   - `can_view: false` is what withholds a section (it governs, since #483), so
 *     an explicit off is a stored decision and not an absence somebody's next
 *     default can fill.
 *
 * `can_edit` comes from the caller's edit set and nowhere else. It used to be
 * inferred — preserved from a prior row, and otherwise hardcoded to "everything
 * but the decision log" — which meant the screen decided about writing without
 * showing it, and left no way back: a section turned off and on again came back
 * read-only and stayed read-only, because the panel had no edit control at all.
 * A section that cannot be read is still never editable, whatever the edit set
 * says: writing into content you cannot see is how a writer destroys what they
 * never knew was there.
 *
 * Anything in `view` that `offered` does not list is appended rather than
 * dropped. `offered` is the server's allowlist; if it ever arrives short of a
 * section the project actually shares, silently omitting the row would unshare
 * it — the panel must never delete what it could not display.
 */
export function sectionRowsFor(
  offered: string[],
  permissions: SharePermissions,
): ShareSectionRow[] {
  const view = new Set(permissions.view);
  const edit = new Set(permissions.edit);
  const keys = [...offered, ...[...view].filter((key) => !offered.includes(key))];
  return keys.map((section_key) => {
    const can_view = view.has(section_key);
    return { section_key, can_view, can_edit: can_view && edit.has(section_key) };
  });
}
