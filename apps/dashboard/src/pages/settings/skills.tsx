import Head from 'next/head';
import { useEffect, useState } from 'react';
import { InlineErrorState, PageScaffold, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { RefusalNotice, loadFailureFrom } from '@/components/dashboard/RefusalNotice';
import { isRefusedLoad, type LoadFailure } from '@/lib/loadFailure';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { api, apiErrorReason, isApiError, type SharedSkill } from '@/lib/api';
import { canEditSkill, skillRefusalMessage } from '@/lib/skillErrors';
import { logger } from '@/lib/logger';
import { showToast } from '@/components/ui/Toast';

// A blank SKILL.md scaffold so the markdown textarea starts with the frontmatter
// the sync pipeline expects (name/description) rather than an empty buffer.
function skillTemplate(name: string, description: string): string {
  return `---\nname: ${name || 'My skill'}\ndescription: ${description || 'What this skill does and when to use it.'}\n---\n\n# ${name || 'My skill'}\n\nDescribe the workflow, steps, or know-how this skill captures.\n`;
}

type ScopeChoice = 'workspace' | 'project';
// How a new skill is authored: pasted SKILL.md text, or imported from a GitHub URL.
type CreateMode = 'text' | 'github';

function ScopeBadge({ projectId }: { projectId: string | null }) {
  const workspace = projectId === null;
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full border ${
        workspace
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border-subtle text-text-muted'
      }`}
    >
      {workspace ? 'Workspace' : 'Project'}
    </span>
  );
}

// Segmented toggle at the top of the New-skill modal — switches the body between
// authoring a SKILL.md by hand and importing one from a GitHub URL.
function ModeSelector({ mode, onChange }: { mode: CreateMode; onChange: (mode: CreateMode) => void }) {
  const options: { id: CreateMode; label: string }[] = [
    { id: 'text', label: 'From text' },
    { id: 'github', label: 'From GitHub' },
  ];
  return (
    <div
      role="tablist"
      aria-label="How to add the skill"
      className="inline-flex w-fit gap-1 rounded-lg border border-border-subtle bg-overlay-subtle p-1"
    >
      {options.map((option) => {
        const active = mode === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.id)}
            className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              active ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// Scope picker shared by both modes — a skill is either workspace-wide or scoped
// to a single project, regardless of how it was authored.
function ScopeFields({
  scope,
  onScopeChange,
  projectId,
  onProjectIdChange,
}: {
  scope: ScopeChoice;
  onScopeChange: (scope: ScopeChoice) => void;
  projectId: string;
  onProjectIdChange: (projectId: string) => void;
}) {
  return (
    <>
      <label className="grid gap-2">
        <span className="dashboard-eyebrow">Scope</span>
        <select
          value={scope}
          onChange={(e) => onScopeChange(e.target.value as ScopeChoice)}
          className="dashboard-select"
        >
          <option value="workspace">Workspace (all projects)</option>
          <option value="project">Single project</option>
        </select>
      </label>

      {scope === 'project' ? (
        <label className="grid gap-2">
          <span className="dashboard-eyebrow">Project ID</span>
          <input
            value={projectId}
            onChange={(e) => onProjectIdChange(e.target.value)}
            placeholder="project_…"
            className="dashboard-input font-mono"
          />
        </label>
      ) : null}
    </>
  );
}

function SkillCard({
  skill,
  onEdit,
  onToggle,
  onDelete,
}: {
  skill: SharedSkill;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  // Edit, Delete and the switch are all writes, and all three are refused for a
  // colleague's skill. Offering them anyway cost somebody their whole edit
  // before the API said no.
  const editable = canEditSkill(skill);
  return (
    <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-sm text-text-primary truncate">{skill.name}</div>
          <div className="text-[11px] text-text-muted mt-0.5 font-mono">{skill.slug}</div>
        </div>
        <ScopeBadge projectId={skill.project_id} />
      </div>
      <p className="text-xs leading-5 text-text-secondary flex-1">{skill.description}</p>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-1">
        <label className="inline-flex items-center gap-2 text-[11px] text-text-secondary">
          <button
            type="button"
            role="switch"
            aria-checked={skill.enabled}
            aria-disabled={!editable}
            disabled={!editable}
            onClick={editable ? onToggle : undefined}
            className={`relative h-4 w-7 rounded-full transition-colors ${
              skill.enabled ? 'bg-primary' : 'bg-overlay-strong'
            } ${editable ? '' : 'cursor-not-allowed opacity-60'}`}
          >
            {/* The knob's ink has to flip with the STATE, not just the theme:
                the on-track is a bright emerald fill and the off-track is a
                low-alpha neutral, so no single colour clears WCAG 1.4.11's 3:1
                against both. Measured against the real token values —
                on-track #10B981 dark / #047857 light, off-track compositing to
                #252f3d dark / #ececee light:
                  on  + --on-primary   7.56:1 dark, 5.48:1 light
                  off + --text-primary 12.14:1 dark, 14.65:1 light
                The bug this replaces was `bg-white` in both states: 2.54:1 on
                the dark on-track, and 1.18:1 on the light off-track, where the
                switch could not report its own state at all. Both tokens
                already existed and already flip — E-016 assumed this needed a
                new token pair and it does not. */}
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full transition-[left] ${
                skill.enabled ? 'left-3.5 bg-on-primary' : 'left-0.5 bg-text-primary'
              }`}
            />
          </button>
          {skill.enabled ? 'Enabled' : 'Disabled'}
        </label>
        {editable ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onEdit}
              className="text-[11px] font-semibold text-primary hover:underline"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="text-[11px] text-text-muted hover:text-status-danger transition-colors"
            >
              Delete
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-text-muted">Written by a teammate. Only they or an owner can change it.</span>
        )}
      </div>
    </div>
  );
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<SharedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinguishes "you have no skills" from "we could not find out".
  const [loadError, setLoadError] = useState<Error | null>(null);
  // ...and "the workspace refused it" (its subscription is inactive) from both.
  const [refusal, setRefusal] = useState<LoadFailure | null>(null);
  const [editing, setEditing] = useState<SharedSkill | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // One modal, two ways in: author a SKILL.md by hand ('text') or import from a
  // GitHub URL ('github'). Editing always uses the text form.
  const [createMode, setCreateMode] = useState<CreateMode>('text');

  // Form fields (no form library — mirrors integrations.tsx). Scope/projectId are
  // shared across both modes; each mode adds its own input (markdown vs. repo URL).
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [scope, setScope] = useState<ScopeChoice>('workspace');
  const [projectId, setProjectId] = useState('');
  const [importUrl, setImportUrl] = useState('');

  // Editing pins the modal to the text form; otherwise the selector drives it.
  const effectiveMode: CreateMode = editing ? 'text' : createMode;

  // A failed load used to leave `skills` at [] and fall through to the "No
  // shared skills yet" panel — so an account whose skills did not load was told
  // it had none, and invited to create the first one it already had.
  const load = () => {
    setLoading(true);
    setLoadError(null);
    setRefusal(null);
    api.getSharedSkills()
      .then((rows) => {
        setSkills(rows);
        setLoadError(null);
      })
      .catch(async (e: unknown) => {
        const failure = await loadFailureFrom(e);
        // A refusal is the workspace's state, which the page explains; it is
        // not a fault to report.
        if (isRefusedLoad(failure)) {
          setRefusal(failure);
          return;
        }
        logger.error('skills_load_failed', e);
        setLoadError(isApiError(e) ? e : new Error('skills_load_failed'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setEditing(null);
    setCreateMode('text');
    setName('');
    setDescription('');
    setMarkdown(skillTemplate('', ''));
    setScope('workspace');
    setProjectId('');
    setImportUrl('');
    setModalOpen(true);
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (isImporting) return;
    if (!importUrl.trim()) {
      showToast('Paste a GitHub repo URL', 'error');
      return;
    }
    const resolvedProjectId = scope === 'project' && projectId.trim() ? projectId.trim() : null;
    setIsImporting(true);
    try {
      const { skill } = await api.importSkillFromGithub({ repo_url: importUrl.trim(), project_id: resolvedProjectId });
      showToast(`Imported “${skill.name}”`, 'success');
      setModalOpen(false);
      load();
    } catch (err: unknown) {
      logger.error('skill_import_failed', err);
      // throwApiError puts the API's `error` string on either code or message.
      const reason = apiErrorReason(err) || '';
      const messages: Record<string, string> = {
        skills_limit_exceeded: 'You’ve reached your skills limit. Upgrade to add more.',
        skill_file_not_found: 'No SKILL.md found there. Point to the repo, folder, or file that contains it.',
        github_url_required: 'Paste a GitHub repo URL.',
        github_url_invalid: 'That doesn’t look like a GitHub repo URL.',
        github_url_unsupported_host: 'Only public github.com repos can be imported.',
        github_rate_limited: 'GitHub rate limit hit — try again in a minute.',
        github_fetch_failed: 'Couldn’t reach that repo. Check the URL and that it’s public.',
        skill_contains_secret: 'That SKILL.md contains a secret and was rejected.',
      };
      showToast(skillRefusalMessage(err) || messages[reason] || 'Failed to import skill', 'error');
    } finally {
      setIsImporting(false);
    }
  }

  async function openEdit(skill: SharedSkill) {
    setEditing(skill);
    setCreateMode('text');
    setName(skill.name);
    setDescription(skill.description);
    setScope(skill.project_id ? 'project' : 'workspace');
    setProjectId(skill.project_id ?? '');
    setMarkdown(skillTemplate(skill.name, skill.description));
    setModalOpen(true);
    // The list endpoint omits markdown_content — fetch the full body for editing.
    try {
      const full = await api.getSharedSkill(skill.skill_id);
      if (full.markdown_content) setMarkdown(full.markdown_content);
    } catch (e: unknown) {
      logger.error('skill_detail_load_failed', e);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (isSaving) return;
    if (!name.trim() || !description.trim() || !markdown.trim()) {
      showToast('Name, description, and markdown are required', 'error');
      return;
    }
    const resolvedProjectId = scope === 'project' && projectId.trim() ? projectId.trim() : null;
    setIsSaving(true);
    try {
      if (editing) {
        await api.updateSharedSkill(editing.skill_id, {
          name: name.trim(),
          description: description.trim(),
          markdown_content: markdown,
          project_id: resolvedProjectId,
        });
        showToast('Skill updated', 'success');
      } else {
        await api.createSharedSkill({
          name: name.trim(),
          description: description.trim(),
          markdown_content: markdown,
          project_id: resolvedProjectId,
        });
        showToast('Skill created', 'success');
      }
      setModalOpen(false);
      load();
    } catch (err: unknown) {
      logger.error('skill_save_failed', err);
      // apiErrorReason, not err.code: the quota refusal is
      // `{ error: 'skills_limit_exceeded', upgrade_required: true }` with no
      // `code` key at all, so `err.code === 'skills_limit_exceeded'` was a
      // branch that could never be taken and every capped save read as a
      // generic "Failed to save skill".
      if (apiErrorReason(err) === 'skills_limit_exceeded') {
        showToast('You’ve reached your skills limit. Upgrade to add more.', 'error');
      } else {
        showToast(skillRefusalMessage(err) || 'Failed to save skill', 'error');
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggle(skill: SharedSkill) {
    // Optimistic flip — revert on failure.
    setSkills((prev) => prev.map((s) => (s.skill_id === skill.skill_id ? { ...s, enabled: !s.enabled } : s)));
    try {
      await api.updateSharedSkill(skill.skill_id, { enabled: !skill.enabled });
    } catch (err: unknown) {
      logger.error('skill_toggle_failed', err);
      setSkills((prev) => prev.map((s) => (s.skill_id === skill.skill_id ? { ...s, enabled: skill.enabled } : s)));
      showToast(skillRefusalMessage(err) || 'Failed to update skill', 'error');
    }
  }

  async function handleDelete(skill: SharedSkill) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete the skill “${skill.name}”?`)) return;
    try {
      await api.deleteSharedSkill(skill.skill_id);
      setSkills((prev) => prev.filter((s) => s.skill_id !== skill.skill_id));
      showToast('Skill deleted', 'success');
    } catch (err: unknown) {
      logger.error('skill_delete_failed', err);
      showToast(skillRefusalMessage(err) || 'Failed to delete skill', 'error');
    }
  }

  const modalDescription =
    effectiveMode === 'github'
      ? 'Paste a public GitHub repo, folder, or SKILL.md link. DeerDawn fetches the SKILL.md, reads its frontmatter, and adds it as a shared skill.'
      : 'The markdown is the full SKILL.md, frontmatter included. DeerDawn keeps it current in every tool.';

  return (
    <>
      <Head>
        <title>Shared Skills | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Shared Skills"
        description="Write a workflow once and DeerDawn distributes it as a skill across every connected tool. Skills ride the same sync loop as your context."
        action={<Button onClick={openCreate}>New skill</Button>}
      >
        <SurfacePanel className="p-6">
          {loading ? (
            <div className="text-sm text-text-secondary">Loading skills…</div>
          ) : refusal ? (
            <RefusalNotice failure={refusal} />
          ) : loadError ? (
            <InlineErrorState
              title="Couldn't load your skills"
              description="The list didn't come back, so we can't tell you what's there. Nothing was changed; retrying is safe."
              onRetry={load}
              requestId={isApiError(loadError) ? loadError.requestId : undefined}
            />
          ) : skills.length === 0 ? (
            <div className="rounded-2xl border border-border-subtle bg-background p-8 text-center">
              <div className="text-sm font-semibold text-text-primary">No shared skills yet</div>
              <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-text-secondary">
                Capture a repeatable workflow as a SKILL.md — write it yourself or import one from GitHub — and DeerDawn syncs it to Claude, Cursor, and Codex, workspace-wide or scoped to a project.
              </p>
              <div className="mt-4 flex justify-center">
                <Button onClick={openCreate}>Create your first skill</Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.skill_id}
                  skill={skill}
                  onEdit={() => openEdit(skill)}
                  onToggle={() => handleToggle(skill)}
                  onDelete={() => handleDelete(skill)}
                />
              ))}
            </div>
          )}
        </SurfacePanel>
      </PageScaffold>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        labelledById="skill-modal-title"
        cardClassName="w-full max-w-[640px] rounded-[28px] border border-border-subtle bg-background p-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
      >
        <div className="grid gap-5">
          <div>
            <h2 id="skill-modal-title" className="text-base font-semibold text-text-primary">
              {editing ? 'Edit skill' : 'New skill'}
            </h2>
            <p className="mt-1 text-xs text-text-secondary">{modalDescription}</p>
          </div>

          {!editing ? <ModeSelector mode={createMode} onChange={setCreateMode} /> : null}

          {effectiveMode === 'github' ? (
            <form onSubmit={handleImport} className="grid gap-5">
              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Repository URL</span>
                <input
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  autoFocus
                  spellCheck={false}
                  className="dashboard-input font-mono text-[12px]"
                />
              </label>

              <ScopeFields
                scope={scope}
                onScopeChange={setScope}
                projectId={projectId}
                onProjectIdChange={setProjectId}
              />

              <div className="flex gap-3">
                <Button type="submit" isLoading={isImporting}>
                  Import skill
                </Button>
                <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSave} className="grid gap-5">
              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Release checklist"
                  className="dashboard-input"
                />
              </label>

              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Description</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this skill does and when to use it."
                  className="dashboard-input"
                />
              </label>

              <ScopeFields
                scope={scope}
                onScopeChange={setScope}
                projectId={projectId}
                onProjectIdChange={setProjectId}
              />

              <label className="grid gap-2">
                <span className="dashboard-eyebrow">SKILL.md</span>
                <textarea
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  rows={12}
                  spellCheck={false}
                  className="dashboard-textarea font-mono text-[12px] leading-5"
                />
              </label>

              <div className="flex gap-3">
                <Button type="submit" isLoading={isSaving}>
                  {editing ? 'Save changes' : 'Create skill'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      </Modal>
    </>
  );
}
