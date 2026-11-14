import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isApiError, type ContextProjectSummary, type ProjectSharing, type TeamMember } from '@/lib/api';
import { assignableMembers, unknownAuthorIds } from '@/lib/authorUnknown';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { showToast } from '@/components/ui/Toast';
import { logger } from '@/lib/logger';
import { projectActionRefusal } from '@/lib/writeRefusal';

type ArchivedProject = { project_id: string; project_name: string; archived_at?: string | null };

interface ProjectManagerProps {
  open: boolean;
  onClose: () => void;
  /** The live tree, as the switcher renders it. */
  projects: ContextProjectSummary[];
  /** Re-fetch the tree after any change. */
  onChanged: (focusProjectId?: string) => void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (isApiError(err) && err.message) return projectActionRefusal(err.message);
  return fallback;
}

/**
 * Create, rename, move, archive, restore and delete projects.
 *
 * Every action here already existed in the API and over MCP; the dashboard
 * offered only "create", and only during onboarding. With 30-day auto-archive on
 * by default, that also meant an archived project could not be brought back from
 * the product at all.
 *
 * Permissions are the server's, and a refusal is shown as the server worded it:
 * archive, move and delete go through assertProjectMutable, rename through
 * assertProjectRenamable. A colleague's private project is its author's to delete,
 * archive, move or share while they are in the workspace (an owner may once they
 * have left), and only a shared project's author or an owner may rename it. A
 * project the person cannot see is answered as not found.
 */
export function ProjectManager({ open, onClose, projects, onChanged }: ProjectManagerProps) {
  const confirm = useConfirm();
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [archived, setArchived] = useState<ArchivedProject[] | null>(null);
  // Owners only: projects whose author cannot be identified (the server sends the
  // flag to owners and nobody else), and the active members one may be assigned to.
  const [unknownAuthors, setUnknownAuthors] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState('');

  const rows = useMemo(
    () => projects.flatMap((root) => [
      { project: root, depth: 0 },
      ...(root.subprojects ?? []).map((sub) => ({ project: sub, depth: 1 })),
    ]),
    [projects],
  );

  const loadArchived = useCallback(() => {
    api
      .getArchivedContextProjects()
      .then(setArchived)
      .catch((err) => {
        logger.error('project_manager_archived_failed', err);
        setArchived([]);
      });
  }, []);

  const loadUnknownAuthors = useCallback(() => {
    api
      .getProjectSharing()
      .then((page: { projects?: ProjectSharing[] }) => {
        const ids = unknownAuthorIds(page.projects);
        setUnknownAuthors(ids);
        if (ids.size > 0) api.getTeam().then((roster) => setMembers(assignableMembers(roster.members))).catch(() => setMembers([]));
      })
      // A workspace with no team, or a caller who may not read the listing: nothing to show.
      .catch(() => setUnknownAuthors(new Set()));
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    loadArchived();
    loadUnknownAuthors();
  }, [open, loadArchived, loadUnknownAuthors]);

  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      logger.error('project_manager_action_failed', err);
      setError(errorMessage(err, failure));
    } finally {
      setBusy(null);
    }
  };

  const create = () => run('create', async () => {
    const name = newName.trim();
    if (!name) return;
    const { project } = await api.createContextProject({ project_name: name });
    setNewName('');
    showToast(`Created ${project.project_name}`, 'success');
    onChanged(project.project_id);
  }, 'Could not create that project.');

  const rename = (project: ContextProjectSummary) => run(`rename:${project.project_id}`, async () => {
    const name = editName.trim();
    if (!name || name === project.project_name) {
      setEditingId(null);
      return;
    }
    await api.renameContextProject(project.project_id, name);
    setEditingId(null);
    showToast(`Renamed to ${name}`, 'success');
    onChanged();
  }, 'Could not rename that project.');

  const move = (project: ContextProjectSummary, parentId: string) => run(`move:${project.project_id}`, async () => {
    await api.setContextProjectParent(project.project_id, parentId || null);
    showToast(parentId ? `Moved ${project.project_name}` : `${project.project_name} is now top level`, 'success');
    onChanged();
  }, 'Could not move that project.');

  const archive = (project: ContextProjectSummary) => run(`archive:${project.project_id}`, async () => {
    const ok = await confirm({
      title: `Archive ${project.project_name}?`,
      body: 'It leaves your project list and stops appearing in briefs. Nothing is deleted, and you can restore it here any time.',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    await api.archiveContextProject(project.project_id);
    showToast(`Archived ${project.project_name}`, 'success');
    loadArchived();
    onChanged();
  }, 'Could not archive that project.');

  const restore = (project: ArchivedProject) => run(`restore:${project.project_id}`, async () => {
    await api.archiveContextProject(project.project_id, { unarchive: true });
    showToast(`Restored ${project.project_name}`, 'success');
    loadArchived();
    onChanged(project.project_id);
  }, 'Could not restore that project.');

  const remove = (project: { project_id: string; project_name: string }) => run(`delete:${project.project_id}`, async () => {
    const ok = await confirm({
      title: `Delete ${project.project_name} permanently?`,
      body: 'This removes its brief, board, decisions and memory graph. It cannot be undone. If you might want it later, archive it instead.',
      confirmLabel: 'Delete permanently',
      destructive: true,
    });
    if (!ok) return;
    await api.deleteContextProject(project.project_id);
    showToast(`Deleted ${project.project_name}`, 'success');
    loadArchived();
    onChanged();
  }, 'Could not delete that project.');

  const assignAuthor = (project: ContextProjectSummary) => run(`assign:${project.project_id}`, async () => {
    if (!assignTo) return;
    await api.assignProjectAuthor(project.project_id, assignTo);
    const who = members.find((m) => m.id === assignTo);
    setAssigningId(null);
    setAssignTo('');
    showToast(`${who?.email || 'That person'} is now the author of ${project.project_name}`, 'success');
    loadUnknownAuthors();
    onChanged();
  }, 'Could not assign that project.');

  // Only a top-level project with no subprojects of its own can become a parent
  // target; the hierarchy is one level deep and the server refuses anything else.
  const parentOptions = (project: ContextProjectSummary) =>
    projects.filter((root) => root.project_id !== project.project_id);

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledById="project-manager-title"
      cardClassName="w-full max-w-[720px] max-h-[85vh] overflow-y-auto rounded-[20px] border border-border-subtle bg-background p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)] max-sm:p-4"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 id="project-manager-title" className="text-lg font-semibold text-text-primary">Manage projects</h2>
          <p className="mt-1 text-sm text-text-secondary">Create, rename, move, archive, restore or delete.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <form
        className="mb-6 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="dashboard-eyebrow mb-2 block">New project</span>
          <input
            className="dashboard-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name"
            maxLength={120}
          />
        </label>
        <Button type="submit" size="md" isLoading={busy === 'create'} disabled={!newName.trim() || busy !== null}>
          Create
        </Button>
      </form>

      {error ? (
        <p role="alert" className="mb-4 rounded-lg border border-status-danger/40 px-3 py-2 text-sm text-status-danger">
          {error}
        </p>
      ) : null}

      <h3 className="dashboard-eyebrow mb-2">Projects ({rows.length})</h3>
      {rows.length === 0 ? (
        <p className="mb-6 text-sm text-text-muted">No projects yet.</p>
      ) : (
        <ul className="mb-6 divide-y divide-border-subtle rounded-xl border border-border-subtle">
          {rows.map(({ project, depth }) => {
            const id = project.project_id;
            const hasChildren = (project.subprojects ?? []).length > 0;
            const isEditing = editingId === id;
            const rowBusy = busy !== null && busy.endsWith(`:${id}`);
            return (
              <li key={id} className={`flex flex-wrap items-center gap-2 px-3 py-2.5 ${depth ? 'pl-8' : ''}`}>
                <div className="min-w-[160px] flex-1">
                  {isEditing ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void rename(project);
                      }}
                    >
                      <input
                        className="dashboard-input h-9"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        aria-label={`New name for ${project.project_name}`}
                        maxLength={120}
                        autoFocus
                      />
                      <Button type="submit" size="sm" isLoading={busy === `rename:${id}`}>Save</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <>
                    <span className="block truncate text-sm font-medium text-text-primary">
                      {depth ? <span aria-hidden className="mr-1.5 text-text-muted">└─</span> : null}
                      {project.project_name}
                      {unknownAuthors.has(id) ? (
                        <span
                          className="ml-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-status-warning"
                          title="Nobody can be identified as this project's author, so nobody can manage it. An owner can assign one active member."
                        >
                          Author unknown
                        </span>
                      ) : null}
                    </span>
                    {assigningId === id ? (
                      <form
                        className="mt-2 flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void assignAuthor(project);
                        }}
                      >
                        <select
                          aria-label={`Author of ${project.project_name}`}
                          className="dashboard-input h-9 w-auto py-0 text-xs"
                          value={assignTo}
                          onChange={(e) => setAssignTo(e.target.value)}
                        >
                          <option value="">Choose a member</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>{member.email || member.id}</option>
                          ))}
                        </select>
                        <Button type="submit" size="sm" disabled={!assignTo || busy !== null} isLoading={busy === `assign:${id}`}>Assign</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setAssigningId(null)}>Cancel</Button>
                      </form>
                    ) : null}
                    </>
                  )}
                </div>
                {!isEditing ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => {
                        setEditingId(id);
                        setEditName(project.project_name);
                      }}
                    >
                      Rename
                    </Button>
                    {unknownAuthors.has(id) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => {
                          setAssigningId(id);
                          setAssignTo('');
                        }}
                      >
                        Assign author
                      </Button>
                    ) : null}
                    {!hasChildren ? (
                      <select
                        aria-label={`Move ${project.project_name}`}
                        className="dashboard-input h-9 w-auto py-0 text-xs"
                        value={project.parent_project_id || ''}
                        disabled={busy !== null}
                        onChange={(e) => void move(project, e.target.value)}
                      >
                        <option value="">Top level</option>
                        {parentOptions(project).map((root) => (
                          <option key={root.project_id} value={root.project_id}>
                            Under {root.project_name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {/* An umbrella with live children cannot be archived —
                        archiving it would hide work the user is still doing —
                        and the server refuses with a 409. Offering the button
                        anyway makes the refusal look like a failure, so it is
                        shut with the reason attached, exactly as Delete already
                        is on the same condition. */}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null || hasChildren}
                      isLoading={busy === `archive:${id}`}
                      onClick={() => void archive(project)}
                      title={hasChildren ? 'Archive or move its subprojects first' : undefined}
                    >
                      Archive
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy !== null || hasChildren} isLoading={rowBusy && busy?.startsWith('delete:')} onClick={() => void remove(project)} title={hasChildren ? 'Move or delete its subprojects first' : undefined}>
                      Delete
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="dashboard-eyebrow mb-2">Archived {archived ? `(${archived.length})` : ''}</h3>
      {archived === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : archived.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing archived. Projects idle for 30 days are archived automatically and show up here.</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
          {archived.map((project) => (
            <li key={project.project_id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <div className="min-w-[160px] flex-1">
                <span className="block truncate text-sm font-medium text-text-secondary">{project.project_name}</span>
                {project.archived_at ? (
                  <span className="text-[11px] text-text-muted">Archived {new Date(project.archived_at).toLocaleDateString()}</span>
                ) : null}
              </div>
              <Button size="sm" variant="secondary" disabled={busy !== null} isLoading={busy === `restore:${project.project_id}`} onClick={() => void restore(project)}>
                Restore
              </Button>
              <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void remove(project)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
