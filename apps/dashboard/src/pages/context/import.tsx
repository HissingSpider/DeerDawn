import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { parseImportFile, parsePaste, type ImportProject } from '@/lib/importParsers';
import { notProcessedMessage, notProcessedOf, type SeedResult } from '@/lib/importOutcome';
import { trackProductEvent } from '@/lib/productAnalytics';
import { WhatYourAiReadsPanel } from '@/components/dashboard/brief/WhatYourAiReadsPanel';

type Step = 'choose' | 'preview' | 'importing' | 'done';

interface ProjectToggle extends ImportProject {
  enabled: boolean;
  renamed: string;
}

// Derive a sensible project name from a pasted CLAUDE.md / AGENTS.md.
function derivePrefillName(text: string): string {
  const project = text.match(/^\s*Project\s*[:\-]\s*(.+)$/im)?.[1]?.trim();
  if (project) return project.slice(0, 80);
  const heading = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.replace(/\.md$/i, '').slice(0, 80);
  return 'My project';
}

export default function ImportPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('choose');
  const [projects, setProjects] = useState<ProjectToggle[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [pasteProjectName, setPasteProjectName] = useState('');
  // The project whose brief we render on the success screen — the "aha" before any
  // tool is connected. Resolved by name after import (the /seed response returns
  // counts, not ids).
  const [briefProjectId, setBriefProjectId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; results?: SeedResult }>({ done: 0, total: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const viewedRef = useRef(false);

  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    trackProductEvent('context_import_viewed', {
      source: 'dashboard',
      path: '/context/import',
    });
  }, []);

  const loadProjects = (parsed: ImportProject[]) => {
    setProjects(parsed.map((p) => ({ ...p, enabled: true, renamed: p.name })));
    setStep('preview');
  };

  // Prefill handoff from /onboarding: the user previewed a CLAUDE.md/AGENTS.md and
  // clicked "Import this to my workspace →". Rebuild a single project from the stashed
  // raw text and jump straight to the preview step so the context actually lands.
  const prefillConsumed = useRef(false);
  useEffect(() => {
    if (!router.isReady || prefillConsumed.current) return;
    if (!router.query.prefill) return;
    prefillConsumed.current = true;
    let text = '';
    try {
      text = sessionStorage.getItem('deerdawn_prefill_text') || '';
      sessionStorage.removeItem('deerdawn_prefill_text');
      sessionStorage.removeItem('deerdawn_prefill');
    } catch {}
    if (!text.trim()) return;
    const parsed = parsePaste(text, derivePrefillName(text));
    if (parsed.length === 0) return;
    trackProductEvent('context_import_prefill_loaded', {
      source: 'dashboard',
      path: '/context/import',
      metadata: { project_count: parsed.length },
    });
    loadProjects(parsed);
  }, [router.isReady, router.query.prefill]);

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseImportFile(file);
      if (parsed.length === 0) {
        showToast('No conversations found in this file.', 'error');
        return;
      }
      trackProductEvent('context_import_file_parsed', {
        source: 'dashboard',
        path: '/context/import',
        metadata: {
          file_name: file.name,
          project_count: parsed.length,
        },
      });
      loadProjects(parsed);
    } catch (err: any) {
      showToast(err.message || 'Could not parse file.', 'error');
    }
  }, []);

  const handlePaste = () => {
    if (!pasteText.trim()) return;
    const parsed = parsePaste(pasteText, pasteProjectName.trim() || 'Imported conversation');
    if (parsed.length === 0) {
      showToast('Could not find any messages in the text.', 'error');
      return;
    }
    trackProductEvent('context_import_paste_parsed', {
      source: 'dashboard',
      path: '/context/import',
      metadata: {
        project_count: parsed.length,
        project_name: pasteProjectName.trim() || 'Imported conversation',
      },
    });
    loadProjects(parsed);
  };

  const handleImport = async () => {
    const enabled = projects.filter((p) => p.enabled);
    if (enabled.length === 0) return;

    setProgress({ done: 0, total: enabled.length });
    setStep('importing');
    trackProductEvent('context_import_started', {
      source: 'dashboard',
      path: '/context/import',
      metadata: {
        project_count: enabled.length,
      },
    });

    try {
      const payload = {
        source: 'manual' as const,
        projects: enabled.map((p) => ({
          name: p.renamed || p.name,
          conversations: p.conversations,
        })),
      };

      const result = await api.seedContext(payload);
      await trackProductEvent('context_import_succeeded', {
        source: 'dashboard',
        path: '/context/import',
        metadata: {
          project_count: enabled.length,
          projects_created: result.projects_created,
          projects_skipped: result.projects_skipped,
          projects_not_processed: notProcessedOf(result).length,
        },
      });
      if (result.projects_created > 0) {
        await trackProductEvent('project_created', {
          source: 'dashboard',
          path: '/context/import',
          metadata: { projects_created: result.projects_created, via: 'context_import' },
        });
      }
      setProgress({ done: enabled.length, total: enabled.length, results: result });
      setStep('done');

      // Resolve the newly-created project so the success screen can render its
      // real brief ("here's what your AI will read") with zero tool setup. The
      // /seed response only returns counts, so match by name, falling back to the
      // most recently updated project. Best-effort — the screen still works without it.
      if (result.projects_created > 0) {
        try {
          const all = await api.getContextProjects();
          const wantName = (enabled[0]?.renamed || enabled[0]?.name || '').trim().toLowerCase();
          const match = wantName ? all.find((p) => (p.project_name || '').trim().toLowerCase() === wantName) : undefined;
          const newest = [...all].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
          const target = match || newest;
          if (target) {
            setBriefProjectId(target.project_id);
            trackProductEvent('context_brief_previewed', {
              source: 'dashboard',
              path: '/context/import',
              metadata: { via: 'context_import' },
            });
          }
        } catch {
          // Non-fatal: no live brief preview, but the import still succeeded.
        }
      }
    } catch (err: any) {
      trackProductEvent('context_import_failed', {
        source: 'dashboard',
        path: '/context/import',
        metadata: {
          project_count: enabled.length,
          reason: err?.message || 'import_failed',
        },
      });
      showToast(err.message || 'Import failed.', 'error');
      setStep('preview');
    }
  };

  return (
    <>
      <Head><title>Import history | DeerDawn</title></Head>

      <div className="mx-auto max-w-2xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <Link href="/" className="text-xs text-text-muted hover:text-text-primary transition-colors">← Overview</Link>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-text-primary">Import conversation history</h1>
          <p className="mt-1 text-sm text-text-muted">
            Seed DeerDawn with context from your existing ChatGPT, Claude, or other AI conversations. Any tool you connect after this will start with full context.
          </p>
        </div>

        {step === 'choose' && (
          <div className="space-y-4">
            {/* File upload */}
            <div
              className="rounded-2xl border border-border-subtle bg-overlay-subtle p-6 cursor-pointer hover:border-border-strong transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <input ref={fileRef} type="file" accept=".json,.zip,.txt" className="hidden" onChange={handleFile} />
              <div className="text-sm font-medium text-text-primary mb-1">Upload a data export</div>
              <div className="text-xs text-text-muted leading-5">
                Works with <strong className="text-text-secondary">ChatGPT</strong> (Settings → Data Controls → Export) and{' '}
                <strong className="text-text-secondary">Claude</strong> (Settings → Privacy → Export). Upload the <code className="text-primary/70">conversations.json</code> file.
              </div>
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary">
                Choose file
              </div>
            </div>

            {/* Paste */}
            <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-6">
              <div className="text-sm font-medium text-text-primary mb-1">Paste a conversation</div>
              <div className="text-xs text-text-muted mb-4">Works with any AI tool. Paste the conversation text and DeerDawn will extract the project context from it.</div>
              <input
                type="text"
                name="paste-project-name"
                aria-label="Project name"
                value={pasteProjectName}
                onChange={(e) => setPasteProjectName(e.target.value)}
                placeholder="Project name (optional)"
                className="dashboard-input mb-3"
              />
              <textarea
                name="paste-text"
                aria-label="Conversation text"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={"Human: I'm building a React app with...\nAssistant: Sure, let's start with..."}
                rows={6}
                className="dashboard-textarea resize-none font-mono"
              />
              <div className="mt-3">
                <Button size="sm" onClick={handlePaste} disabled={!pasteText.trim()}>
                  Parse conversation
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-4">
            <div className="text-xs font-medium uppercase tracking-widest text-text-muted mb-2">
              {projects.filter((p) => p.enabled).length} of {projects.length} projects selected
            </div>

            {projects.map((proj, i) => (
              <div key={i} className={`rounded-2xl border p-4 transition-colors ${proj.enabled ? 'border-border-subtle bg-overlay-subtle' : 'border-border-subtle bg-transparent opacity-50'}`}>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setProjects((ps) => ps.map((p, j) => j === i ? { ...p, enabled: !p.enabled } : p))}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] transition-colors ${proj.enabled ? 'border-primary/50 bg-primary/15 text-primary' : 'border-border-strong text-transparent'}`}
                  >
                    ✓
                  </button>
                  <input
                    type="text"
                    value={proj.renamed}
                    onChange={(e) => setProjects((ps) => ps.map((p, j) => j === i ? { ...p, renamed: e.target.value } : p))}
                    className="flex-1 bg-transparent text-sm font-medium text-text-primary outline-none border-b border-transparent focus:border-border-strong"
                  />
                  <span className="text-xs text-text-muted shrink-0">
                    {proj.conversations.reduce((n, c) => n + c.messages.length, 0)} messages
                  </span>
                </div>
                <div className="mt-2 ml-8 text-xs text-text-muted">
                  {proj.conversations.length} conversation{proj.conversations.length !== 1 ? 's' : ''}
                  {proj.conversations[0]?.title ? ` · "${proj.conversations[0].title}"${proj.conversations.length > 1 ? ` +${proj.conversations.length - 1} more` : ''}` : ''}
                </div>
              </div>
            ))}

            <div className="flex gap-3 pt-2">
              <Button onClick={handleImport} disabled={projects.filter((p) => p.enabled).length === 0}>
                Import {projects.filter((p) => p.enabled).length} project{projects.filter((p) => p.enabled).length !== 1 ? 's' : ''}
              </Button>
              <Button variant="secondary" onClick={() => { setStep('choose'); setProjects([]); }}>
                Start over
              </Button>
            </div>
          </div>
        )}

        {step === 'importing' && (
          <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-8 text-center">
            <div className="text-sm font-medium text-text-primary mb-2">Importing…</div>
            <div className="text-xs text-text-muted">
              Processing {progress.total} project{progress.total !== 1 ? 's' : ''}. This takes a few seconds per project.
            </div>
            <div className="mt-6 h-1 w-full rounded-full bg-overlay-active">
              <div
                className="h-1 rounded-full bg-primary transition-all duration-500"
                style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 10}%` }}
              />
            </div>
          </div>
        )}

        {step === 'done' && (() => {
          const created = progress.results?.projects_created ?? 0;
          const skipped = progress.results?.projects_skipped ?? 0;
          const errored = progress.results?.errors?.length ?? 0;
          // Projects no model processed: nothing from them was saved, and they
          // are never counted as imported (see lib/importOutcome).
          const notProcessed = notProcessedOf(progress.results).length;
          const notProcessedLine = notProcessedMessage(progress.results);
          const landed = created > 0;
          return (
            <div className={`rounded-2xl border p-8 ${landed ? 'border-primary/25 bg-primary/5' : 'border-border-subtle bg-overlay-subtle'}`}>
              <div className="text-base font-semibold text-text-primary mb-1">
                {created} project{created !== 1 ? 's' : ''} imported
                {skipped > 0 ? <span className="font-normal text-text-muted"> · {skipped} skipped</span> : null}
                {notProcessed > 0 ? <span className="font-normal text-text-muted"> · {notProcessed} not processed</span> : null}
              </div>
              <div className="text-sm text-text-muted mb-6">
                {landed
                  ? <>DeerDawn built a brief from your history. The panel below is exactly what your AI reads at the start of every session — connect a tool to turn it on across Claude, ChatGPT, Cursor &amp; Codex.{skipped > 0 ? ' A few conversations were skipped — they didn’t have enough substance to build context from.' : ''}{notProcessedLine ? ` ${notProcessedLine}` : ''}</>
                  : notProcessedLine
                    ? notProcessedLine
                  : errored > 0
                    ? 'Something went wrong while importing. Please try again — if it keeps happening, let us know.'
                    : 'These conversations didn’t have enough substance to build context from. Try a longer conversation, or upload a full data export.'}
              </div>

              {/* The aha: show the real, populated brief before asking for any tool
                  setup. Framed as a pull toward connecting ("turn on the thing you
                  can already see"), not a destination. */}
              {landed && (
                <div className="mb-6">
                  <WhatYourAiReadsPanel projectId={briefProjectId} />
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {landed ? (
                  <>
                    <Link href="/setup" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-[#0ea871] transition-colors">
                      Connect a tool →
                    </Link>
                    <Link href="/memory" className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors">
                      View context graph
                    </Link>
                  </>
                ) : notProcessed > 0 ? (
                  <>
                    {/* The selection is still here: back to it, one click from Import. */}
                    <Button onClick={() => setStep('preview')}>
                      Try the import again
                    </Button>
                    <Link href="/" className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors">
                      Back to overview
                    </Link>
                  </>
                ) : (
                  <>
                    <Button onClick={() => { setStep('choose'); setProjects([]); setPasteText(''); setPasteProjectName(''); }}>
                      Try a different import
                    </Button>
                    <Link href="/" className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors">
                      Back to overview
                    </Link>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
