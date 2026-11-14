import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { SkeletonNetwork } from '@/components/dashboard/SkeletonNetwork';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { logger } from '@/lib/logger';
import { showToast } from '@/components/ui/Toast';
import { writeRefusalMessage } from '@/lib/writeRefusal';
import {
  BRIEF_BUSY_MESSAGE,
  isStaleVersionError,
  mergeLineEdits,
  projectEditorPatch,
  writeFromFreshRead,
} from '@/lib/briefEdits';

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (86400 * 7))}w ago`;
}

// ─── types ────────────────────────────────────────────────────────────────────

type DisplayNode = {
  id: string; label: string; type: string; summary: string;
  confidence: number; projectId?: string | null; isProject: boolean;
  updatedAt?: string; _key?: string;
  parentId?: string | null;    // umbrella project id for a subproject hub
  ctx?: Record<string, any>;  // full context object for project nodes
  fullText?: string;           // untruncated text for content nodes
};
type DisplayEdge = { id: string; from: string; to: string; type: string };

// ─── Emerald-led palette (matches the marketing hero graph) ───────────────────
// Emerald primary (tasks/goals), amber + rose as the only two supporting hues
// (decisions / open questions), near-white project+profile hubs, slate for the
// stack/files that should recede. Disciplined, on-brand — not a 6-hue rainbow.

const TYPE_COLOR: Record<string, string> = {
  // Hubs use the primary text token so they invert with the theme (near-white on
  // dark, dark-navy on light) instead of a fixed near-white that vanishes on a
  // light surface. The rest are brand/status hues that read on both themes.
  project:       'var(--text-primary)',      // theme-aware — project hubs
  task:          'rgba(16,185,129,0.95)',    // emerald (primary)
  current_task:  'rgba(16,185,129,0.95)',
  goal:          'rgba(110,231,183,0.90)',   // light emerald
  decision:      'rgba(251,191,36,0.92)',    // amber (support)
  open_question: 'rgba(251,113,133,0.92)',   // rose (support)
  service:       'rgba(148,163,184,0.70)',   // slate — stack recedes
  repo:          'rgba(148,163,184,0.70)',
  stack:         'rgba(148,163,184,0.70)',
  file:          'rgba(148,163,184,0.58)',   // slate (dim)
  // global / "you" nodes
  profile:       'var(--text-primary)',      // theme-aware — profile hubs
  preference:    'rgba(148,163,184,0.65)',
  instruction:   'rgba(251,191,36,0.78)',
};
function nodeColor(t: string) { return TYPE_COLOR[t] || 'rgba(148,163,184,0.55)'; }

function toDisplayCase(s: string): string {
  if (!s) return s;
  // If mostly uppercase (allcaps label from seeded context), convert to Title Case
  const upper = (s.match(/[A-Z]/g) || []).length;
  const alpha = (s.match(/[a-zA-Z]/g) || []).length;
  if (alpha > 3 && upper / alpha > 0.7) {
    return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }
  // Multi-word prose stored lowercase (e.g. "be concise") → sentence case, so
  // leaf items match the capitalized category headers and hub names. Only the
  // first letter is touched, preserving intentional casing ("prefer TypeScript"),
  // and paths/code-like tokens ("apps/api/foo.js") are left alone.
  if (/^[a-z]/.test(s) && /\s/.test(s) && !s.includes('/')) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

// ─── noise filter ─────────────────────────────────────────────────────────────

const ALLCAPS_SHORT = /^[A-Z_\-]{1,12}$/; // log prefixes, env vars
const ABS_PATH = /^\/(?:Users|home|var|tmp|etc)\//;
// 'project' excluded — those come from getContextProjects() and would duplicate
const MEANINGFUL_TYPES = new Set(['task','decision','goal','service','repo','open_question','file','current_task']);

const STOPWORDS = new Set([
  'the','a','an','is','it','in','on','at','to','of','for','and','or','but',
  'with','that','this','these','those','was','were','be','been','being',
  'have','has','had','do','does','did','not','from','by','as','are','its',
  'our','my','your','their','we','i','you','he','she','they','what','which',
  'who','when','where','how','all','any','some','no','new','old','one','two',
  'three','so','if','then','than','just','very','also','can','will','would',
  'could','should','may','might','use','using','used','make','made','get',
  'got','set','see','look','need','want','work','working','run','running',
]);

function cleanTitle(raw: string): string {
  // Strip leading articles
  return raw.trim().replace(/^(the|a|an)\s+/i, '').trim();
}

function isUsefulNode(n: { node_type: string; title: string; confidence: number }): boolean {
  if (!MEANINGFUL_TYPES.has(n.node_type)) return false;
  if (n.confidence < 0.35) return false;
  const raw = n.title.trim();
  if (raw.length < 4) return false;
  if (ALLCAPS_SHORT.test(raw)) return false;
  if (ABS_PATH.test(raw)) return false;
  if (/^\w+\.\w+$/.test(raw) && raw.length < 10) return false;

  const t = cleanTitle(raw);
  if (t.length < 4) return false;

  // Reject if every word is a stopword
  const words = t.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0 || words.every(w => STOPWORDS.has(w))) return false;

  // Reject single generic words
  if (words.length === 1 && STOPWORDS.has(words[0])) return false;

  // Reject vague sentence-fragment titles (starts lowercase + no capital/digit anywhere)
  if (/^[a-z]/.test(t) && !/[A-Z0-9\/\.]/.test(t) && words.length <= 2) return false;

  return true;
}

// ─── org-chart tree model ──────────────────────────────────────────────────────
// The old force-directed graph is replaced by a hierarchical, click-to-expand
// breakdown: hubs (You + each project) → category groups (tasks, goals, decisions,
// questions, tech…) → the individual context items. It renders as plain indented
// rows — no physics, no pan/zoom — so it paints instantly and stays snappy.

const CAT_ORDER = ['current_task','task','goal','decision','open_question','service','stack','preference','instruction','repo','file'];
const CAT_LABEL: Record<string, string> = {
  current_task: 'Current task', task: 'Tasks', goal: 'Goals', decision: 'Decisions',
  open_question: 'Open questions', service: 'Tech & tools', stack: 'Tech stack',
  preference: 'Preferences', instruction: 'Instructions', repo: 'Repos', file: 'Files',
};
const catLabel = (t: string) => CAT_LABEL[t] || t.replace(/_/g, ' ');

// Only these edge types denote ownership (hub → item). 'relates' cross-links are
// intentionally ignored so an item lives under exactly one parent (a clean tree).
const OWNER_EDGES = new Set(['contains', 'uses', 'prefers', 'rule']);

type CatGroup = { key: string; type: string; label: string; items: DisplayNode[] };
type Branch = { hub: DisplayNode; groups: CatGroup[]; count: number; subBranches: Branch[] };
type BranchView = { hub: DisplayNode; groups: CatGroup[]; rawCount: number; visibleCount: number; hubMatches: boolean; subBranches: BranchView[] };

function buildTree(nodes: DisplayNode[], edges: DisplayEdge[]): Branch[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const hubs = nodes.filter(n => n.isProject || n.type === 'profile');
  // "You" (profile) pinned first, then projects most-recent first.
  hubs.sort((a, b) => {
    const ap = a.type === 'profile' ? 0 : 1, bp = b.type === 'profile' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });

  const claimed = new Set<string>();   // each item belongs to a single hub
  const branches: Branch[] = [];
  for (const hub of hubs) {
    const kids: DisplayNode[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.from !== hub.id || !OWNER_EDGES.has(e.type)) continue;
      const child = byId.get(e.to);
      if (!child || child.isProject || child.type === 'profile') continue;
      if (claimed.has(child.id) || seen.has(child.id)) continue;
      seen.add(child.id); claimed.add(child.id); kids.push(child);
    }

    const groups: CatGroup[] = [];
    const known = new Set(CAT_ORDER);
    for (const type of CAT_ORDER) {
      const items = kids.filter(k => k.type === type);
      if (items.length) groups.push({ key: `${hub.id}::${type}`, type, label: catLabel(type), items });
    }
    // Any unforeseen types keep a home rather than vanishing.
    for (const type of Array.from(new Set(kids.filter(k => !known.has(k.type)).map(k => k.type)))) {
      groups.push({ key: `${hub.id}::${type}`, type, label: catLabel(type), items: kids.filter(k => k.type === type) });
    }
    branches.push({ hub, groups, count: kids.length, subBranches: [] });
  }
  // Nest subprojects under their umbrella so the tree mirrors the real
  // parent→child project hierarchy instead of rendering every project flat. A
  // child whose parent isn't visible falls back to top-level (never vanishes).
  const branchById = new Map(branches.map(b => [b.hub.id, b]));
  const roots: Branch[] = [];
  for (const b of branches) {
    const parent = b.hub.parentId ? branchById.get(b.hub.parentId) : null;
    if (parent && parent !== b) parent.subBranches.push(b);
    else roots.push(b);
  }
  return roots;
}

// ─── node detail panel ────────────────────────────────────────────────────────

// Parse "X vs Y", "X or Y", "X, Y, or Z" patterns out of a question string
function parseQuestionOptions(question: string): string[] {
  const vsMatch = question.match(/\b([\w\s\-\/]+?)\s+(?:vs\.?|versus|or)\s+([\w\s\-\/]+?)(?:[?.,]|$)/i);
  if (vsMatch) return [vsMatch[1].trim(), vsMatch[2].trim()].filter(o => o.length > 0 && o.length < 40);
  const listMatch = question.match(/\b([\w\s\-\/]+),\s*([\w\s\-\/]+),?\s+or\s+([\w\s\-\/]+?)(?:[?.,]|$)/i);
  if (listMatch) return [listMatch[1].trim(), listMatch[2].trim(), listMatch[3].trim()].filter(o => o.length > 0 && o.length < 40);
  return [];
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function NodeDetailPanel({ node, onClose, onDelete, edges, allNodes, onRefresh, isMobile = false }: { node: DisplayNode; onClose: () => void; onDelete: (id: string) => void; edges: DisplayEdge[]; allNodes: DisplayNode[]; onRefresh: () => void; isMobile?: boolean }) {
  const color = nodeColor(node.type);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editFields, setEditFields] = useState<Record<string, any>>({});
  // What the editor opened with, to tell what the person changed from what the
  // page merely loaded (see projectEditorPatch).
  const [editStart, setEditStart] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState(false);
  const [resolveAnswer, setResolveAnswer] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  // One-time note on the You panel: the server says whether this profile still
  // needs the person's look. Cleared by dismissing it or by saving the profile.
  const [reviewNeeded, setReviewNeeded] = useState(false);
  useEffect(() => {
    if (node.id !== 'global:you') return;
    let cancelled = false;
    api.getProfileReviewNeeded().then((needed) => { if (!cancelled) setReviewNeeded(needed); }).catch(() => {});
    return () => { cancelled = true; };
  }, [node.id]);
  async function dismissReview() {
    setReviewNeeded(false);
    try { await api.dismissProfileReview(); } catch (err) { logger.error('profile_review_dismiss_failed', err); }
  }

  const isQuestion = node.type === 'open_question';
  const questionText = node.fullText || node.label;
  const parsedOptions = isQuestion ? parseQuestionOptions(questionText) : [];

  async function handleResolve(answer: string) {
    if (!answer.trim() || !node.projectId) return;
    setResolving(true);
    try {
      await api.resolveQuestion(node.projectId, questionText, answer.trim());
      onRefresh();
    } catch { setResolving(false); }
  }

  function startEdit() {
    if (node.id === 'global:you') {
      const g = node as any;
      setEditFields({
        user_profile: node.fullText || '',
        preferences: (g._prefs || []).join('\n'),
        instructions: (g._instrs || []).join('\n'),
        global_stack: (g._stack || []).join(', '),
        goals: (g._goals || []).join('\n'),
        expertise_areas: (g._expertise || []).join('\n'),
        values: (g._values || []).join('\n'),
        working_style: g._workingStyle || '',
        communication_preferences: g._communication || '',
      });
    } else if (node.isProject && node.ctx) {
      const fields = { project_name: node.ctx.project_name || node.label, description: node.ctx.description || '', current_task: node.ctx.current_task || '', current_status: node.ctx.current_status || '', goals: (node.ctx.goals || []).join('\n') };
      setEditFields(fields);
      setEditStart(fields);
    }
    setEditing(true);
  }

  async function saveEdit() {
    setSaving(true);
    try {
      if (node.id === 'global:you') {
        await api.updateGlobalContext({
          user_profile: editFields.user_profile,
          preferences: editFields.preferences.split('\n').map((s: string) => s.trim()).filter(Boolean),
          recurring_instructions: editFields.instructions.split('\n').map((s: string) => s.trim()).filter(Boolean),
          global_stack: editFields.global_stack.split(',').map((s: string) => s.trim()).filter(Boolean),
          goals: editFields.goals.split('\n').map((s: string) => s.trim()).filter(Boolean),
          expertise_areas: editFields.expertise_areas.split('\n').map((s: string) => s.trim()).filter(Boolean),
          values: editFields.values.split('\n').map((s: string) => s.trim()).filter(Boolean),
          working_style: editFields.working_style.trim(),
          communication_preferences: editFields.communication_preferences.trim(),
        });
        // A save is the person's own look at the profile.
        setReviewNeeded(false);
      } else if (node.isProject) {
        // Only what the person changed. This sent all five fields back from
        // the copy /memory loaded, so a rename also put back the task, status
        // and goals of that moment over whatever the person's AI tool had
        // written since (the brief's own edit bug, journey r3 S3-1). Goals are
        // merged as line edits onto the list as it is when Save is pressed,
        // guarded on the version of that read.
        const changes = projectEditorPatch(editStart, editFields);
        if (changes?.goals) {
          const { original, edited } = changes.goals;
          await writeFromFreshRead(
            {
              read: () => api.getProjectContextJson(node.id),
              write: (patch, expectedVersion) =>
                api.updateProjectContext(node.id, patch as never, { expectedContextVersion: expectedVersion }),
            },
            (fresh) => ({
              ...changes.scalars,
              goals: mergeLineEdits(original, edited, Array.isArray(fresh.goals) ? fresh.goals.filter((g): g is string => typeof g === 'string') : []),
            }),
          );
        } else if (changes) {
          await api.updateProjectContext(node.id, changes.scalars as never);
        }
      }
      setEditing(false);
      onRefresh();
    } catch (err: unknown) {
      // Was a bare `catch {}`: the panel simply stopped saving, with no toast
      // and no log, so a teammate refused on a shared project saw the editor
      // sit there as if they had not pressed anything.
      logger.error('context_node_save_failed', err);
      showToast(
        isStaleVersionError(err) ? BRIEF_BUSY_MESSAGE : writeRefusalMessage(err) || 'Couldn’t save that change.',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  // Find connected project names
  const connectedProjectIds = edges
    .filter(e => e.from === node.id || e.to === node.id)
    .map(e => e.from === node.id ? e.to : e.from);
  const connectedProjects = allNodes.filter(n => n.isProject && connectedProjectIds.includes(n.id));

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteGraphNode(node.id);
      onDelete(node.id);
    } catch (err: unknown) {
      logger.error('context_node_delete_failed', err);
      showToast(writeRefusalMessage(err) || 'Couldn’t delete that.', 'error');
      setDeleting(false);
    }
  }

  const ctx = node.ctx;
  const canEdit = node.isProject || node.id === 'global:you';
  const fullText = node.fullText || node.label;
  const genericSummaries = new Set(['recent decision','open question','project goal','current task','tech / tool','tech stack','working preference','part of your global tech stack','standing instruction — applies to every session']);
  const showSummary = !node.isProject && node.summary && node.summary !== node.label && !genericSummaries.has(node.summary.toLowerCase());

  // Desktop: 300px right-side panel (top:0, right:0, full height, left border).
  // Mobile only: full-width bottom sheet (~70vh) anchored to the bottom with a top
  // border + rounded top corners.
  const panelStyle: React.CSSProperties = isMobile
    ? { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '70%', display: 'flex', flexDirection: 'column', overflowY: 'auto', width: '100%', background: 'var(--background)', borderTop: '1px solid var(--border-subtle)', borderTopLeftRadius: 16, borderTopRightRadius: 16, boxShadow: '0 -12px 32px rgba(0,0,0,0.45)', zIndex: 10 }
    : { position: 'absolute', top: 0, right: 0, height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', width: 300, background: 'var(--background)', borderLeft: '1px solid var(--border-subtle)', zIndex: 10 };

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '20px 20px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color, marginBottom: 6 }}>
            {node.type.replace(/_/g, ' ')}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>{toDisplayCase(node.label)}</div>
          {node.updatedAt && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Briefed {timeAgo(node.updatedAt)}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginTop: 2 }}>
          {canEdit && !editing && (
            <button onClick={startEdit} style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--overlay-active)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>Edit</button>
          )}
          <button onClick={onClose} style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div style={{ padding: '12px 20px 16px', display: 'flex', flexDirection: 'column', gap: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          {node.id === 'global:you' ? (
            <>
              {[['user_profile','About you','textarea'],['preferences','Preferences (one per line)','textarea'],['instructions','Always do (one per line)','textarea'],['global_stack','Default stack (comma separated)','input'],['goals','Goals (one per line)','textarea'],['expertise_areas','Expertise (one per line)','textarea'],['values','Values (one per line)','textarea'],['working_style','Working style','input'],['communication_preferences','Communication','input']].map(([key, label, type]) => (
                <div key={key as string}>
                  <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label as string}</label>
                  {type === 'textarea'
                    ? <textarea value={editFields[key as string] || ''} name={key as string} aria-label={label as string} onChange={e => setEditFields(f => ({...f, [key as string]: e.target.value}))} rows={3} style={{ width: '100%', borderRadius: 8, padding: '6px 8px', fontSize: isMobile ? 16 : 12, color: 'var(--text-primary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                    : <input value={editFields[key as string] || ''} name={key as string} aria-label={label as string} onChange={e => setEditFields(f => ({...f, [key as string]: e.target.value}))} style={{ width: '100%', borderRadius: 8, padding: '6px 8px', fontSize: isMobile ? 16 : 12, color: 'var(--text-primary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none', boxSizing: 'border-box' }} />}
                </div>
              ))}
            </>
          ) : (
            <>
              {[['project_name','Name','input'],['description','Description','textarea'],['current_task','Working on now','textarea'],['current_status','Status','input'],['goals','Goals (one per line)','textarea']].map(([key, label, type]) => (
                <div key={key as string}>
                  <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label as string}</label>
                  {type === 'textarea'
                    ? <textarea value={editFields[key as string] || ''} name={key as string} aria-label={label as string} onChange={e => setEditFields(f => ({...f, [key as string]: e.target.value}))} rows={key === 'description' || key === 'goals' ? 3 : 2} style={{ width: '100%', borderRadius: 8, padding: '6px 8px', fontSize: isMobile ? 16 : 12, color: 'var(--text-primary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                    : <input value={editFields[key as string] || ''} name={key as string} aria-label={label as string} onChange={e => setEditFields(f => ({...f, [key as string]: e.target.value}))} style={{ width: '100%', borderRadius: 8, padding: '6px 8px', fontSize: isMobile ? 16 : 12, color: 'var(--text-primary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none', boxSizing: 'border-box' }} />}
                </div>
              ))}
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={saveEdit} disabled={saving} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: 'var(--primary)', border: 'none', borderRadius: 8, padding: '5px 14px', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* You: the one-time note, then the lines that may have been filled in from projects */}
        {node.id === 'global:you' && reviewNeeded && (
          <div role="note" style={{ border: '1px solid var(--border-subtle)', background: 'var(--overlay-hover)', borderRadius: 8, padding: '10px 12px' }}>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 8px' }}>
              Some of this may have been filled in automatically from your projects. Please check it.
            </p>
            <button onClick={dismissReview} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer' }}>Dismiss</button>
          </div>
        )}
        {node.id === 'global:you' && !editing && (() => {
          const g = node as any;
          const rows: Array<[string, string]> = [
            ['Goals', (g._goals || []).join('\n')],
            ['Expertise', (g._expertise || []).join('\n')],
            ['Values', (g._values || []).join('\n')],
            ['Working style', g._workingStyle || ''],
            ['Communication', g._communication || ''],
          ];
          return rows.filter(([, text]) => text).map(([label, text]) => (
            <Section key={label} label={label}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}>{text}</p>
            </Section>
          ));
        })()}

        {/* Project: rich context view */}
        {node.isProject && ctx && (
          <>
            {ctx.description && (
              <Section label="About">
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{ctx.description}</p>
              </Section>
            )}
            {ctx.current_status && (
              <Section label="Status">
                <span style={{ fontSize: 12, color: 'var(--primary)', background: 'rgba(16,185,129,0.1)', borderRadius: 6, padding: '3px 8px' }}>{ctx.current_status}</span>
              </Section>
            )}
            {ctx.current_task && (
              <Section label="Working on now">
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>{ctx.current_task}</p>
              </Section>
            )}
            {ctx.blocking_issue && (
              <Section label="Blocked by">
                <p style={{ fontSize: 13, color: '#f87171', lineHeight: 1.6, margin: 0 }}>{ctx.blocking_issue}</p>
              </Section>
            )}
            {(ctx.goals || []).length > 0 && (
              <Section label="Goals">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(ctx.goals as string[]).slice(0, 5).map((g, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ color: 'rgba(167,139,250,0.7)', flexShrink: 0, marginTop: 1 }}>◆</span>{g}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}

        {/* Content node: full untruncated text */}
        {!node.isProject && fullText !== node.label && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{fullText}</p>
        )}

        {/* Generic summary (non-duplicate) */}
        {showSummary && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, margin: 0 }}>{node.summary}</p>
        )}

        {/* Connected projects (for content nodes only) */}
        {!node.isProject && connectedProjects.length > 0 && (
          <Section label={connectedProjects.length === 1 ? 'Project' : `${connectedProjects.length} Projects`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {connectedProjects.map(p => (
                <div key={p.id} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--overlay-hover)', borderRadius: 6, padding: '4px 8px' }}>
                  {toDisplayCase(p.label)}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Question resolve UI */}
        {isQuestion && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Resolve</div>
            {parsedOptions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {parsedOptions.map(opt => (
                  <button key={opt} onClick={() => { setResolveAnswer(opt); setShowCustomInput(false); }}
                    style={{ fontSize: 12, padding: '4px 10px', borderRadius: 7, cursor: 'pointer', border: '1px solid', borderColor: resolveAnswer === opt ? 'rgba(16,185,129,0.5)' : 'var(--border-strong)', background: resolveAnswer === opt ? 'rgba(16,185,129,0.12)' : 'var(--overlay-hover)', color: resolveAnswer === opt ? 'var(--primary)' : 'var(--text-muted)', transition: 'all 0.12s' }}>
                    {opt}
                  </button>
                ))}
                <button onClick={() => { setShowCustomInput(true); setResolveAnswer(''); }}
                  style={{ fontSize: 12, padding: '4px 10px', borderRadius: 7, cursor: 'pointer', border: '1px solid', borderColor: showCustomInput ? 'rgba(16,185,129,0.5)' : 'var(--border-strong)', background: showCustomInput ? 'rgba(16,185,129,0.12)' : 'var(--overlay-hover)', color: showCustomInput ? 'var(--primary)' : 'var(--text-muted)' }}>
                  Other…
                </button>
              </div>
            )}
            {(parsedOptions.length === 0 || showCustomInput) && (
              <input
                value={resolveAnswer} onChange={e => setResolveAnswer(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleResolve(resolveAnswer)}
                placeholder="Type your answer…"
                style={{ width: '100%', borderRadius: 8, padding: '6px 10px', fontSize: isMobile ? 16 : 12, color: 'var(--text-primary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none', boxSizing: 'border-box' }}
              />
            )}
            <button onClick={() => handleResolve(resolveAnswer)} disabled={resolving || !resolveAnswer.trim()}
              style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: resolveAnswer.trim() ? 'var(--primary)' : 'var(--overlay-strong)', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: resolveAnswer.trim() ? 'pointer' : 'default', alignSelf: 'flex-start', opacity: resolving ? 0.6 : 1, transition: 'background 0.15s' }}>
              {resolving ? 'Resolving…' : 'Resolve →'}
            </button>
          </div>
        )}

        {!node.isProject && (
          <button onClick={handleDelete} disabled={deleting}
            style={{ fontSize: 11, color: deleting ? 'var(--text-muted)' : '#EF4444', background: 'none', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '5px 10px', cursor: deleting ? 'default' : 'pointer', alignSelf: 'flex-start' }}>
            {deleting ? 'Removing…' : 'Remove node'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── empty state ──────────────────────────────────────────────────────────────

const EMPTY_STEPS = [
  {
    title: 'Connect an AI tool',
    body: 'Add the DeerDawn MCP to Claude, Cursor, or Codex in about a minute.',
  },
  {
    title: 'Work like you always do',
    body: 'Keep chatting and coding — no extra commands, no copy-paste.',
  },
  {
    title: 'Your breakdown builds itself',
    body: 'Tasks, decisions, and stack appear here and are handed to every new session.',
  },
];

function EmptyState({ onAddFromClaude }: { onAddFromClaude: () => void }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', overflowY: 'auto', overflowX: 'hidden' }}>
      {/* Ghost of a populated view — show the destination, not just describe it. */}
      <div aria-hidden style={{ position: 'absolute', inset: 0, opacity: 0.6, pointerEvents: 'none' }}>
        <SkeletonNetwork />
      </div>
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, textAlign: 'center', maxWidth: 460 }}>
        <div style={{ width: 56, height: 56, borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/>
            <circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/>
            <path d="M6 6.5l4 4M14 13.5l4 4M6 17.5l4-4M14 10.5l4-4"/>
          </svg>
        </div>

        <div>
          <div className="text-base font-semibold text-text-primary">Your context breakdown starts here</div>
          <p className="text-sm text-text-secondary" style={{ marginTop: 8, lineHeight: 1.6 }}>
            DeerDawn keeps a living brief of your work and hands it to every new session.
            Connect one to watch it fill in — automatically.
          </p>
        </div>

        <ol style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', textAlign: 'left', margin: 0, padding: 0, listStyle: 'none' }}>
          {EMPTY_STEPS.map((step, i) => (
            <li key={step.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: 'var(--primary)', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}>
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-text-primary">{step.title}</div>
                <div className="text-xs text-text-muted" style={{ marginTop: 2, lineHeight: 1.5 }}>{step.body}</div>
              </div>
            </li>
          ))}
        </ol>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
          <Link href="/onboarding" className="text-on-primary text-sm font-semibold"
            style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--primary)', textDecoration: 'none' }}>
            Set up MCP
          </Link>
          <Link href="/context/import" className="text-sm font-medium text-text-secondary"
            style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border-strong)', textDecoration: 'none' }}>
            Import existing context
          </Link>
        </div>

        <button onClick={onAddFromClaude} className="text-xs font-medium text-text-muted hover:text-text-primary"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          or paste from an AI chat →
        </button>
      </div>
    </div>
  );
}

// ─── error state ───────────────────────────────────────────────────────────────

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center', maxWidth: 420 }}>
        <div style={{ width: 56, height: 56, borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--status-deny)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <div>
          <div className="text-base font-semibold text-text-primary">Couldn’t load your context</div>
          <p className="text-sm text-text-secondary" style={{ marginTop: 8, lineHeight: 1.6 }}>
            We couldn’t reach DeerDawn just now. Your context is safe — this is only
            a loading problem. Try again in a moment.
          </p>
        </div>
        <button onClick={onRetry} className="text-sm font-semibold"
          style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', cursor: 'pointer' }}>
          Try again
        </button>
        <div className="text-xs text-text-muted">
          If this keeps happening, email{' '}
          <a href="mailto:support@deerdawn.com" className="text-text-secondary hover:text-text-primary" style={{ textDecoration: 'underline' }}>support@deerdawn.com</a>.
        </div>
      </div>
    </div>
  );
}

// ─── tree rows ─────────────────────────────────────────────────────────────────

function Chevron({ open, faded = false }: { open: boolean; faded?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke={faded ? 'var(--text-muted)' : 'var(--text-secondary)'} strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>
      <path d="M9 6l6 6-6 6"/>
    </svg>
  );
}

function Dot({ color, size = 9 }: { color: string; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 999, background: color, flexShrink: 0, boxShadow: `0 0 0 3px ${color.replace(/[\d.]+\)$/, '0.10)')}` }} />;
}

const rowBtn: React.CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
  borderRadius: 10, padding: '9px 10px', transition: 'background 0.12s',
};

// ─── main ─────────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'current_task', label: 'Current task' },
  { value: 'task', label: 'Tasks' },
  { value: 'goal', label: 'Goals' },
  { value: 'decision', label: 'Decisions' },
  { value: 'open_question', label: 'Questions' },
  { value: 'service', label: 'Tech' },
  { value: 'stack', label: 'Stack' },
  { value: 'preference', label: 'Preferences' },
  { value: 'instruction', label: 'Instructions' },
];

export function ContextNetwork({ onAddFromClaude, refreshToken, onSelectProject }: {
  onAddFromClaude: () => void; refreshToken: number; onSelectProject?: (projectId: string | null) => void;
}) {
  const isMobile = useIsMobile();
  const [allNodes, setAllNodes] = useState<DisplayNode[]>([]);
  const [allEdges, setAllEdges] = useState<DisplayEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Live first-sync watch: silentRef suppresses the skeleton flash while
  // background-polling an empty tree; pollCountRef caps the watch window.
  const silentRef = useRef(false);
  const pollCountRef = useRef(0);
  const didInitExpand = useRef(false);

  const tree = useMemo(() => buildTree(allNodes, allEdges), [allNodes, allEdges]);

  // "Real" context = anything beyond the always-synthesized "You" profile hub.
  // A brand-new account loads with ONLY that lone, childless You node, so
  // `allNodes.length` is 1 (not 0) — which is why the onboarding empty state and
  // the first-sync auto-bloom poll (both keyed on length===0) never fired for
  // new users, leaving them staring at a barren "You / No context yet" tree.
  // Gate on actual content instead.
  const hasRealContext = useMemo(() => allNodes.some((n) => n.type !== 'profile'), [allNodes]);

  // ─── load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    if (!silentRef.current) setLoading(true);
    setLoadError(false);
    async function load() {
      try {
        const projs = await api.getContextProjects();
        if (cancelled) return;

        const nodes: DisplayNode[] = projs.map(p => ({
          id: p.project_id, label: p.project_name, type: 'project',
          summary: [p.context?.current_status, p.context?.current_task].filter(Boolean).join(' · '),
          confidence: 1, projectId: p.project_id, isProject: true,
          parentId: p.parent_project_id ?? null,
          updatedAt: p.updated_at,
          ctx: p.context as Record<string, any>,
        }));
        const edges: DisplayEdge[] = [];
        let edgeCounter = 0;
        const pushEdge = (from: string, to: string, type: string) => {
          if (!from || !to || from === to) return;
          if (!nodes.find((node) => node.id === from) || !nodes.find((node) => node.id === to)) return;
          edges.push({ id: `edge:${edgeCounter++}:${from}:${to}:${type}`, from, to, type });
        };
        const seenKeys = new Set<string>();
        const idMap = new Map<string,string>();

        const graphs = await Promise.allSettled(projs.slice(0,20).map(p => api.getContextProjectGraph(p.project_id)));
        for (const g of graphs) {
          if (g.status !== 'fulfilled') continue;
          const graph = g.value;
          const good = graph.nodes.filter(isUsefulNode);
          for (const n of good) {
            const key = cleanTitle(n.canonical_key || n.title).toLowerCase().trim();
            if (seenKeys.has(key)) {
              const ex = nodes.find(nd => nd._key === key);
              if (ex) idMap.set(n.node_id, ex.id);
              continue;
            }
            seenKeys.add(key);
            idMap.set(n.node_id, n.node_id);
            nodes.push({ id:n.node_id, label:cleanTitle(n.title), type:n.node_type,
              summary:n.summary||n.canonical_key, confidence:n.confidence,
              projectId:n.project_id, isProject:false, _key:key });
          }
          for (const e of graph.edges) {
            const from = idMap.get(e.from_node_id)||e.from_node_id;
            const to   = idMap.get(e.to_node_id)  ||e.to_node_id;
            pushEdge(from, to, e.edge_type);
          }
          if (graph.project_id) {
            for (const n of good.slice(0,8)) {
              const d = idMap.get(n.node_id);
              if (d) pushEdge(graph.project_id, d, 'contains');
            }
          }
        }

        // ── Synthesize nodes from project context fields ──────────────────────────
        // Tech nodes are SHARED across projects by normalized name — Unity in two
        // projects becomes one node with two edges, making the tree interconnected.
        // Questions/decisions/goals are project-specific since they carry unique meaning.
        const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const nodeById = new Map(nodes.map(n => [n.id, n]));

        for (const p of projs) {
          const ctx = p.context as any;
          if (!ctx || !nodeById.has(p.project_id)) continue;

          // Current task — project-specific
          if (ctx.current_task && typeof ctx.current_task === 'string') {
            const id = `${p.project_id}:task`;
            if (!nodeById.has(id)) {
              const full = ctx.current_task as string;
              const nd = { id, label: full.slice(0, 50), fullText: full, type: 'current_task', summary: 'Current task', confidence: 1, projectId: p.project_id, isProject: false };
              nodes.push(nd); nodeById.set(id, nd);
            }
            pushEdge(p.project_id, id, 'contains');
          }

          // Open questions — project-specific (unique insight per project)
          for (const [i, q] of (ctx.open_questions || []).slice(0, 8).entries()) {
            if (typeof q !== 'string' || q.length < 9) continue;
            const id = `${p.project_id}:oq:${i}`;
            if (!nodeById.has(id)) {
              const nd = { id, label: q.slice(0, 50) + (q.length > 50 ? '…' : ''), fullText: q, type: 'open_question', summary: 'Open question', confidence: 0.9, projectId: p.project_id, isProject: false };
              nodes.push(nd); nodeById.set(id, nd);
            }
            pushEdge(p.project_id, id, 'contains');
          }

          // Decisions — project-specific
          for (const [i, d] of (ctx.recent_decisions || []).slice(0, 6).entries()) {
            const label = typeof d === 'string' ? d : (d as any)?.summary;
            if (!label || label.length < 9) continue;
            const id = `${p.project_id}:dec:${i}`;
            if (!nodeById.has(id)) {
              const nd = { id, label: label.slice(0, 50) + (label.length > 50 ? '…' : ''), fullText: label, type: 'decision', summary: 'Recent decision', confidence: 0.9, projectId: p.project_id, isProject: false };
              nodes.push(nd); nodeById.set(id, nd);
            }
            pushEdge(p.project_id, id, 'contains');
          }

          // Goals — project-specific
          for (const [i, g] of (ctx.goals || []).slice(0, 5).entries()) {
            if (typeof g !== 'string' || g.length < 9) continue;
            const id = `${p.project_id}:goal:${i}`;
            if (!nodeById.has(id)) {
              const nd = { id, label: g.slice(0, 50) + (g.length > 50 ? '…' : ''), fullText: g, type: 'goal', summary: 'Project goal', confidence: 0.9, projectId: p.project_id, isProject: false };
              nodes.push(nd); nodeById.set(id, nd);
            }
            pushEdge(p.project_id, id, 'contains');
          }

          // Tech stack — SHARED: same tech in multiple projects = one node, many edges
          for (const t of (ctx.tech_stack || []).slice(0, 8)) {
            if (typeof t !== 'string' || t.length < 2) continue;
            const id = `synth:tech:${normKey(t)}`;
            if (!nodeById.has(id)) {
              const nd = { id, label: t, type: 'service', summary: 'Tech / tool', confidence: 0.85, isProject: false };
              nodes.push(nd); nodeById.set(id, nd);
            }
            // Only add edge if not already present
            if (!edges.find(e => e.from === p.project_id && e.to === id)) {
              pushEdge(p.project_id, id, 'uses');
            }
          }
        }

        // ── Cross-link nodes to projects they semantically mention ────────
        // e.g. "motorcycle simulator" in Miscellaneous → also edges to Motorcycle Simulator
        const projectIndex = nodes
          .filter(n => n.isProject)
          .map(n => {
            const words = n.label.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 3);
            return { id: n.id, words };
          });

        for (const nd of nodes) {
          if (nd.isProject) continue;
          const labelLow = nd.label.toLowerCase();
          const summaryLow = (nd.summary || '').toLowerCase();
          const text = `${labelLow} ${summaryLow}`;
          for (const proj of projectIndex) {
            const matched = proj.words.filter(w => text.includes(w)).length;
            const threshold = proj.words.length >= 3 ? 2 : 1;
            if (matched >= threshold) {
              const alreadyLinked = edges.some(e =>
                (e.from === proj.id && e.to === nd.id) || (e.from === nd.id && e.to === proj.id)
              );
              if (!alreadyLinked) pushEdge(proj.id, nd.id, 'relates');
            }
          }
        }

        // ── Global "You" context ─────────────────────────────────────────
        // ── "You" — always present, general personal knowledge ──────────────
        const youId = 'global:you';
        try {
          const global = await api.getGlobalContext();
          const youNd = { id: youId, label: 'You', type: 'profile',
            summary: global.user_profile || 'Your personal knowledge hub', confidence: 1, isProject: false,
            fullText: global.user_profile || '',
            _prefs: global.preferences || [], _instrs: global.recurring_instructions || [], _stack: global.global_stack || [],
            _goals: global.goals || [], _expertise: global.expertise_areas || [], _values: global.values || [],
            _workingStyle: global.working_style || '', _communication: global.communication_preferences || '' };
          nodes.push(youNd); nodeById.set(youId, youNd);

          for (const tech of (global.global_stack || []).slice(0, 12)) {
            const id = `global:stack:${tech}`;
            if (!nodeById.has(id)) {
              const nd = { id, label: tech, type: 'stack', summary: 'Global tech stack', confidence: 0.9, isProject: false };
              nodes.push(nd); nodeById.set(id, nd);
            }
            pushEdge(youId, id, 'uses');
          }

          const seenPrefs = new Set<string>();
          for (const pref of (global.preferences || []).slice(0, 10)) {
            if (pref.length < 5 || seenPrefs.has(pref.toLowerCase())) continue;
            seenPrefs.add(pref.toLowerCase());
            const id = `global:pref:${pref.slice(0,40)}`;
            nodes.push({ id, label: pref.slice(0, 40) + (pref.length > 40 ? '…' : ''), fullText: pref, type: 'preference',
              summary: 'Working preference', confidence: 0.9, isProject: false });
            pushEdge(youId, id, 'prefers');
          }

          for (const instr of (global.recurring_instructions || []).slice(0, 8)) {
            if (instr.length < 8) continue;
            const id = `global:rule:${instr.slice(0,40)}`;
            nodes.push({ id, label: instr.slice(0, 40) + (instr.length > 40 ? '…' : ''), fullText: instr, type: 'instruction',
              summary: 'Standing instruction', confidence: 0.95, isProject: false });
            pushEdge(youId, id, 'rule');
          }
        } catch {
          // Global context unavailable; the You node was already added above.
        }

        if (cancelled) return;
        setAllNodes(nodes);
        setAllEdges(edges);
      } catch {
        // A genuine fetch failure must NOT masquerade as the "no context yet"
        // empty state — flag it so the user sees an error + retry instead of
        // being told (incorrectly) that they have no context.
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) { setLoading(false); silentRef.current = false; }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshToken, localRefresh]);

  // Live first-sync watch. While the tree is empty (e.g. right after a tool is
  // connected in onboarding), poll for the first context to land so it blooms
  // in automatically — making the empty-state's "watch it fill in" promise
  // true instead of requiring a manual browser reload. Refreshes are SILENT
  // (no skeleton flash); the watch stops as soon as anything appears and
  // self-caps (~5 min) so an idle empty dashboard doesn't poll forever.
  useEffect(() => {
    if (hasRealContext) { pollCountRef.current = 0; return; }
    const id = window.setInterval(() => {
      if (pollCountRef.current >= 50) { window.clearInterval(id); return; }
      pollCountRef.current += 1;
      silentRef.current = true;
      setLocalRefresh((n) => n + 1);
    }, 6000);
    return () => window.clearInterval(id);
  }, [hasRealContext]);

  // First time context lands, open the top hub so the drill-down is visible
  // without a click. Only runs once so it never fights the user's toggles.
  useEffect(() => {
    if (!didInitExpand.current && tree.length) {
      didInitExpand.current = true;
      setExpanded(new Set([tree[0].hub.id]));
    }
  }, [tree]);

  // Keep the right-hand ContextPanel in sync with the focused project.
  useEffect(() => {
    onSelectProject?.(focusedProjectId);
  }, [onSelectProject, focusedProjectId]);

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const openNode = (n: DisplayNode) => {
    setSelectedId(prev => prev === n.id ? null : n.id);
    if (n.projectId) setFocusedProjectId(n.projectId);
  };

  // ─── derived / filtering ─────────────────────────────────────────────────────

  const q = search.trim().toLowerCase();
  const activeSearch = q.length > 0;
  const typeOk = (t: string) => typeFilter === 'all' || t === typeFilter;
  const textMatch = (n: DisplayNode) =>
    n.label.toLowerCase().includes(q) ||
    (n.summary || '').toLowerCase().includes(q) ||
    (n.fullText || '').toLowerCase().includes(q);

  // Filter recursively so a matching subproject keeps its umbrella visible as a
  // path to it, and an umbrella with no direct hits still shows when a child does.
  const filterBranch = (b: Branch): BranchView | null => {
    const hubMatches = !activeSearch || b.hub.label.toLowerCase().includes(q);
    const groups = b.groups
      .filter(g => typeOk(g.type))
      .map(g => ({ ...g, items: g.items.filter(i => !activeSearch || hubMatches || textMatch(i)) }))
      .filter(g => g.items.length > 0);
    const visibleCount = groups.reduce((s, g) => s + g.items.length, 0);
    const subBranches = b.subBranches
      .map(filterBranch)
      .filter((x): x is BranchView => x !== null);
    const selfVisible = groups.length > 0 || (typeFilter === 'all' && (!activeSearch || hubMatches));
    if (!selfVisible && subBranches.length === 0) return null;
    return { hub: b.hub, groups, rawCount: b.count, visibleCount, hubMatches, subBranches };
  };
  const branchesView = tree
    .map(filterBranch)
    .filter((x): x is BranchView => x !== null);

  // While searching, reveal every matching branch/group so hits aren't hidden
  // behind a collapsed row.
  const isOpen = (key: string) => activeSearch ? true : expanded.has(key);

  const selectedNode = selectedId ? allNodes.find(n => n.id === selectedId) || null : null;

  // Recursive row renderer: a hub (You / project), its category groups, and —
  // for umbrella projects — its subprojects nested one level deeper, so the
  // Library mirrors the real project hierarchy instead of a flat list.
  const renderBranch = (bv: BranchView, depth: number): React.ReactElement => {
    const hub = bv.hub;
    const hubOpen = isOpen(hub.id);
    const isYou = hub.type === 'profile';
    const isSub = depth > 0;
    const subCount = bv.subBranches.length;
    return (
      <div key={hub.id} style={{ marginBottom: isSub ? 3 : 6 }}>
        {/* Hub row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => { toggle(hub.id); setFocusedProjectId(isYou ? null : hub.id); }}
            aria-expanded={hubOpen}
            style={{ ...rowBtn, padding: isSub ? '8px 10px' : '10px 10px', background: hubOpen ? 'var(--overlay-subtle)' : 'none' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--overlay-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = hubOpen ? 'var(--overlay-subtle)' : 'none')}>
            <Chevron open={hubOpen} />
            <Dot color={nodeColor(hub.type)} size={isSub ? 9 : 11} />
            <span style={{ fontSize: isSub ? 13 : 14, fontWeight: isSub ? 650 : 700, color: 'var(--text-primary)', letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {toDisplayCase(hub.label)}
            </span>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '2px 7px', flexShrink: 0 }}>
              {isYou ? 'You' : isSub ? 'Subproject' : 'Project'}
            </span>
            {subCount > 0 && (
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--primary)', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 999, padding: '2px 7px', flexShrink: 0 }}>
                {subCount} subproject{subCount > 1 ? 's' : ''}
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
              {activeSearch ? bv.visibleCount : bv.rawCount}
            </span>
          </button>
          <button
            onClick={() => openNode(hub)}
            aria-label={`Open ${toDisplayCase(hub.label)} details`}
            title="Details"
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, color: 'var(--text-muted)', background: 'none', border: '1px solid transparent', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--overlay-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-muted)'; }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>
            </svg>
          </button>
        </div>

        {/* Expanded: this hub's own categories, then any nested subprojects */}
        {hubOpen && (
          <div style={{ marginLeft: 20, marginTop: 2, paddingLeft: 12, borderLeft: '1px solid var(--border-subtle)' }}>
            {bv.groups.length === 0 && subCount === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 10px' }}>No context yet.</div>
            ) : (
              <>
                {bv.groups.map(g => {
                  const gOpen = isOpen(g.key);
                  return (
                    <div key={g.key} style={{ marginBottom: 2 }}>
                      <button
                        onClick={() => toggle(g.key)}
                        aria-expanded={gOpen}
                        style={{ ...rowBtn, padding: '7px 10px' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--overlay-hover)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                        <Chevron open={gOpen} faded />
                        <Dot color={nodeColor(g.type)} size={7} />
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.label}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{g.items.length}</span>
                      </button>

                      {/* Items */}
                      {gOpen && (
                        <div style={{ marginLeft: 19, paddingLeft: 12, borderLeft: '1px solid var(--border-subtle)' }}>
                          {g.items.map(item => {
                            const active = item.id === selectedId;
                            return (
                              <button key={item.id} onClick={() => openNode(item)}
                                style={{ ...rowBtn, padding: '8px 10px', gap: 8,
                                  background: active ? 'rgba(16,185,129,0.10)' : 'none',
                                  border: active ? '1px solid rgba(16,185,129,0.35)' : '1px solid transparent' }}
                                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--overlay-hover)'; }}
                                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'none'; }}>
                                <Dot color={nodeColor(item.type)} size={6} />
                                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: active ? 'var(--text-primary)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {toDisplayCase(item.label)}
                                </span>
                                {item.updatedAt && (
                                  <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--text-muted)' }}>{timeAgo(item.updatedAt)}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Nested subprojects */}
                {subCount > 0 && (
                  <div style={{ marginTop: bv.groups.length ? 8 : 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '4px 10px 3px' }}>
                      Subprojects
                    </div>
                    {bv.subBranches.map(sb => renderBranch(sb, depth + 1))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // Empty / error states only once the load has finished with nothing to show.
  if (!loading && loadError && allNodes.length === 0)
    return <ErrorState onRetry={() => { setLoadError(false); setLoading(true); setLocalRefresh(n => n + 1); }}/>;
  if (!loading && !hasRealContext) return <EmptyState onAddFromClaude={onAddFromClaude}/>;

  const showTree = !loading || allNodes.length > 0;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* Toolbar — search + type filter + add context */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: 1, minWidth: 160 }}>
          <svg style={{ position: 'absolute', left: 10, pointerEvents: 'none', color: 'var(--text-muted)' }} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search your context…" name="context-search" aria-label="Search context"
            style={{ width: '100%', boxSizing: 'border-box', paddingLeft: 30, paddingRight: 10, height: 34, borderRadius: 9, fontSize: isMobile ? 16 : 13, color: 'var(--text-primary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none' }}/>
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} name="context-type-filter" aria-label="Filter context by type"
          style={{ height: 34, borderRadius: 9, padding: '0 8px', fontSize: isMobile ? 16 : 13, color: 'var(--text-secondary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', outline: 'none', cursor: 'pointer' }}>
          {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value} style={{ background: 'var(--background)' }}>{o.label}</option>)}
        </select>
        <button onClick={() => setExpanded(new Set())}
          style={{ height: 34, borderRadius: 9, padding: '0 10px', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--overlay-hover)', border: '1px solid var(--border-subtle)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Collapse all
        </button>
        <button onClick={onAddFromClaude}
          style={{ height: 34, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRadius: 9, fontSize: 12, fontWeight: 600, color: '#fff', background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          Add context
        </button>
      </div>

      {/* Tree body */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '10px 12px 32px' }}>
        {!showTree ? (
          <TreeSkeleton />
        ) : branchesView.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No context matches your filters.
          </div>
        ) : (
          branchesView.map(bv => renderBranch(bv, 0))
        )}
      </div>

      {selectedNode && (
        <NodeDetailPanel node={selectedNode} edges={allEdges} allNodes={allNodes} isMobile={isMobile}
          onClose={() => setSelectedId(null)}
          onDelete={(id) => { setAllNodes(n => n.filter(x => x.id !== id)); setAllEdges(e => e.filter(x => x.from !== id && x.to !== id)); setSelectedId(null); }}
          onRefresh={() => { setSelectedId(null); setLocalRefresh(t => t + 1); }}/>
      )}
    </div>
  );
}

// ─── loading skeleton ───────────────────────────────────────────────────────────

function TreeSkeleton() {
  const rows = [0, 1, 2, 3, 4, 5];
  return (
    <div aria-hidden style={{ padding: '4px 2px' }}>
      {rows.map(i => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px', marginLeft: i % 3 === 0 ? 0 : 24 }}>
          <span style={{ width: i % 3 === 0 ? 11 : 7, height: i % 3 === 0 ? 11 : 7, borderRadius: 999, background: 'var(--overlay-strong)' }} />
          <span style={{ height: 10, width: `${45 - (i % 3) * 8}%`, borderRadius: 6, background: 'var(--overlay-active)' }} />
        </div>
      ))}
      <span className="sr-only" role="status">Loading your context…</span>
    </div>
  );
}
