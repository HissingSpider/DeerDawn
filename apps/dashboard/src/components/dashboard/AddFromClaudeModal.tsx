import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ANNUAL_LABEL, PRO_PLAN_NAME } from '@/lib/planCopy';
import { Modal } from '@/components/ui/Modal';
import { PersonalPlanGate } from '@/components/ui/PersonalPlanGate';
import { failedMessage, failedCount, importVerdict, notProcessedMessage, notProcessedOf, type SeedNotProcessed, type SeedResult } from '@/lib/importOutcome';
import { fileImportBody, parseContextText, TEXT_NOT_STORED_NOTE } from '@/lib/addContextPayload';

const EXPORT_PROMPT = `I want to sync my full context to DeerDawn. Please summarize two things:

1. My active projects — for each: name, description, current status, what I'm working on right now, recent decisions, tech stack, open questions.

2. About me as a person and professional — my domain expertise, long-term goals, how I prefer to work (working style), what I care about (values), and how I communicate best.

Format as plain text with clear sections. Be thorough — this will be injected into every AI tool I use so they understand me as well as you do.`;

type SubmitStatus = 'idle' | 'loading' | 'done' | 'error';
type Tab = 'paste' | 'file' | 'text';

// An import that would open a new workspace hits the same cap as any other
// creation path (contextSyncService.createProject), but /seed reports it as a
// generic per-project error: applyExtraction (contextSyncService.js:~2013)
// swallows project_limit_exceeded and returns null, so the route records
// 'not_persisted' with the reason gone. Key off that exact marker rather than
// "any error": the seed loop pushes {error: err.message} for any throw (LLM,
// DB, network), so a broader predicate would show a paid-conversion screen
// asserting a cause that did not occur. Then confirm against real usage.
//
// NOTE: as of 2026-08-27 no self-serve plan carries a project cap, so the
// `cap != null` guard below means this screen is currently unreachable. It is
// kept rather than deleted because the guard is the correct shape either way —
// it reads the live entitlement instead of assuming — so a future capped plan
// gets a working explanation instead of a silent partial import.
//
// Deliberately NOT gated on projects_created === 0: a Claude export commonly
// parses into several projects, so a capped user importing 5 gets a
// PARTIAL result — some created, the rest cap-blocked. That is the most likely
// shape, and silently reporting only the successes is the dead end this screen
// exists to remove.
async function resolveProjectCapBlock(res: SeedResult): Promise<{ used: number; cap: number; blocked: number } | null> {
  if (!Array.isArray(res.errors)) return null;
  const blocked = res.errors.filter((e) => e?.error === 'not_persisted').length;
  if (blocked === 0) return null;
  try {
    const usage = await api.getUsage();
    const cap = usage.limits?.projects ?? null;
    const used = usage.ledger?.projects ?? 0;
    return cap != null && used >= cap ? { used, cap, blocked } : null;
  } catch {
    // Usage unavailable — say nothing rather than guess at a cause.
    return null;
  }
}

export function AddFromClaudeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('paste');
  const [pasteText, setPasteText] = useState('');
  const [rawText, setRawText] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [result, setResult] = useState<{ projects_created: number; projects_skipped: number; not_processed: SeedNotProcessed[]; failed: number } | null>(null);
  const [capBlock, setCapBlock] = useState<{ used: number; cap: number; blocked: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(EXPORT_PROMPT);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch { /* user can select manually */ }
  }

  // One place decides what an answer from /seed means, so no tab can show a
  // success for an import that saved nothing. A refusal (a non-2xx) throws
  // before this and lands in the tab's error line.
  async function finish(res: SeedResult) {
    const capped = await resolveProjectCapBlock(res);
    const verdict = importVerdict(res);
    if (!capped && verdict === 'failed') {
      setErrorMsg(failedMessage(failedCount(res), false));
      setSubmitStatus('error');
      return;
    }
    setResult({
      projects_created: res.projects_created || 0,
      projects_skipped: res.projects_skipped || 0,
      not_processed: notProcessedOf(res),
      failed: failedCount(res),
    });
    setCapBlock(capped);
    setSubmitStatus('done');
  }

  async function submit(send: () => Promise<SeedResult>) {
    setSubmitStatus('loading');
    setErrorMsg('');
    try {
      await finish(await send());
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitStatus('error');
    }
  }

  async function handleAdd() {
    const trimmed = pasteText.trim();
    if (!trimmed) return;
    await submit(() => api.seedContext({ source: 'claude_export', projects: parseContextText(trimmed) }));
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    await submit(async () => api.seedContext(fileImportBody(await file.text())));
    // Choosing the same file again after a failure must still fire onChange.
    input.value = '';
  }

  async function handleRawText() {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    await submit(() => api.seedContext(fileImportBody(trimmed)));
  }

  const hasContent = pasteText.trim().length > 10;
  const hasRawText = rawText.trim().length > 10;

  return (
    <Modal open onClose={onClose} ariaLabel="Add context" cardClassName="modal-card w-full max-w-[580px]">

        {submitStatus === 'done' && capBlock ? (
          // The import landed nothing and the workspace is at its cap: sell the
          // way out instead of "no new context found", which would be both
          // unhelpful and untrue about why nothing appeared.
          <div className="p-4">
            <PersonalPlanGate
              surface="project_cap"
              feature="unlimited workspaces"
              // Phrased off both numbers because `used` can EXCEED `cap` (a
              // lapsed subscription keeps its projects), and "all N your plan
              // includes" would then be a false statement about the plan.
              // Lead with what actually landed when the import partly succeeded —
              // a partial success plus an explained refusal, never one or the other.
              description={`${
                (result?.projects_created || 0) > 0
                  ? `${result?.projects_created} project${result?.projects_created === 1 ? '' : 's'} imported, and ${capBlock.blocked} more couldn't be.`
                  : "This import didn't create anything new."
              } Your plan includes ${capBlock.cap} workspace${capBlock.cap === 1 ? '' : 's'} and you're using ${capBlock.used}, so DeerDawn can't open another one for ${capBlock.blocked === 1 ? 'it' : 'them'}. ${PRO_PLAN_NAME} removes the cap and keeps history forever — ${ANNUAL_LABEL}, cancel anytime.`}
            />
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => { onDone(); onClose(); }}
                className="cursor-pointer rounded-[12px] border border-border-strong bg-overlay-active px-8 py-2.5 text-[14px] font-medium text-text-primary"
              >
                Close
              </button>
            </div>
          </div>
        ) : submitStatus === 'done' && result && result.projects_created === 0 && result.not_processed.length > 0 ? (
          // No model processed it: nothing from it was saved, and this must not
          // read as "Context added". The pasted text is still in the tab, so
          // "Try again" goes straight back to it.
          <div className="flex flex-col items-center gap-5 px-8 py-10 text-center">
            <div>
              <div className="mb-1.5 text-[16px] font-semibold text-text-primary">Not processed</div>
              <div className="text-[14px] text-text-muted">{notProcessedMessage(result)}</div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setSubmitStatus('idle'); setResult(null); }}
                className="cursor-pointer rounded-[12px] border-none bg-primary px-8 py-2.5 text-[14px] font-semibold text-on-primary"
              >
                Try again
              </button>
              <button
                onClick={() => { onDone(); onClose(); }}
                className="cursor-pointer rounded-[12px] border border-border-strong bg-overlay-active px-8 py-2.5 text-[14px] font-medium text-text-primary"
              >
                Close
              </button>
            </div>
          </div>
        ) : submitStatus === 'done' && result && result.projects_created === 0 ? (
          // Nothing was saved and nothing failed: the text held too little to
          // keep. Never "Context added".
          <div className="flex flex-col items-center gap-5 px-8 py-10 text-center">
            <div>
              <div className="mb-1.5 text-[16px] font-semibold text-text-primary">Nothing added</div>
              <div className="text-[14px] text-text-muted">There was not enough in this text to save. Add a few sentences about the project and try again.</div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setSubmitStatus('idle'); setResult(null); }}
                className="cursor-pointer rounded-[12px] border-none bg-primary px-8 py-2.5 text-[14px] font-semibold text-on-primary"
              >
                Try again
              </button>
              <button
                onClick={() => { onDone(); onClose(); }}
                className="cursor-pointer rounded-[12px] border border-border-strong bg-overlay-active px-8 py-2.5 text-[14px] font-medium text-text-primary"
              >
                Close
              </button>
            </div>
          </div>
        ) : submitStatus === 'done' && result ? (
          <div className="flex flex-col items-center gap-5 px-8 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/15">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <div className="mb-1.5 text-[16px] font-semibold text-text-primary">Context added</div>
              <div className="text-[14px] text-text-muted">
                {`${result.projects_created} project${result.projects_created !== 1 ? 's' : ''} updated in your network.`}
                {result.not_processed.length > 0 ? ` ${notProcessedMessage(result)}` : null}
                {result.failed > 0 ? ` ${failedMessage(result.failed, true)}` : null}
              </div>
            </div>
            <button
              onClick={() => { onDone(); onClose(); }}
              className="cursor-pointer rounded-[12px] border-none bg-primary px-8 py-2.5 text-[14px] font-semibold text-on-primary"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="modal-header px-8 pt-7 pb-5">
              <h2 className="modal-title">Add context</h2>
              <button className="modal-close" onClick={onClose}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="-mb-px flex gap-1 px-8">
              {(['paste', 'text', 'file'] as Tab[]).map(t => (
                <button key={t} onClick={() => { setTab(t); setSubmitStatus('idle'); setErrorMsg(''); }} className="cursor-pointer rounded-t-lg border px-3.5 py-1.5 text-[13px] font-medium transition-all duration-100" style={{ borderBottom: tab === t ? '1px solid var(--background)' : '1px solid var(--border-subtle)', background: tab === t ? 'var(--background)' : 'transparent', color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)', borderColor: tab === t ? 'var(--border-subtle)' : 'transparent' }}>
                  {t === 'paste' ? 'From AI' : t === 'text' ? 'Paste text' : 'From file'}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="flex flex-col gap-5 border-t border-border-subtle px-8 pt-5 pb-7">

              {/* Plain text paste tab */}
              {tab === 'text' && (
                <div>
                  <p className="m-0 mb-4 text-[13px] leading-[1.6] text-text-muted">
                    Paste any text — a CLAUDE.md, notes, a README, anything describing a project. DeerDawn will extract what matters.
                  </p>
                  <p className="m-0 mb-4 text-[12px] leading-[1.6] text-text-muted">{TEXT_NOT_STORED_NOTE}</p>
                  <textarea
                    value={rawText}
                    onChange={(e) => { setRawText(e.target.value); setSubmitStatus('idle'); setErrorMsg(''); }}
                    placeholder="Paste your context here…"
                    rows={10}
                    disabled={submitStatus === 'loading'}
                    className="box-border w-full resize-none rounded-[12px] border border-border-subtle bg-overlay-hover px-4 py-3.5 text-[13px] leading-[1.6] text-text-primary caret-primary outline-none [font-family:inherit]"
                  />
                  {errorMsg && <div className="mt-2 text-[12px] text-[#f87171]">{errorMsg}</div>}
                </div>
              )}

              {/* File import tab */}
              {tab === 'file' && (
                <div>
                  <p className="m-0 mb-4 text-[13px] leading-[1.6] text-text-muted">
                    Import a <code className="rounded-sm bg-overlay-strong px-[5px] py-px">CLAUDE.md</code>, <code className="rounded-sm bg-overlay-strong px-[5px] py-px">.cursorrules</code>, <code className="rounded-sm bg-overlay-strong px-[5px] py-px">AGENTS.md</code>, or any markdown/text file with project context.
                  </p>
                  <p className="m-0 mb-4 text-[12px] leading-[1.6] text-text-muted">{TEXT_NOT_STORED_NOTE}</p>
                  <input ref={fileInputRef} type="file" accept=".md,.txt,.cursorrules,text/*" className="hidden" onChange={handleFileSelect} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={submitStatus === 'loading'}
                    className="w-full cursor-pointer rounded-[12px] border-none bg-primary p-3.5 text-[14px] font-semibold text-on-primary" style={{ opacity: submitStatus === 'loading' ? 0.5 : 1 }}>
                    {submitStatus === 'loading' ? 'Importing…' : 'Choose file'}
                  </button>
                  {errorMsg && <div className="mt-3 text-[13px] text-[#f87171]">{errorMsg}</div>}
                </div>
              )}

              {tab === 'paste' && <>
                {/* Step 1 */}
                <div>
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-overlay-strong text-[11px] font-bold text-text-primary">1</span>
                    <span className="text-[14px] font-medium text-text-primary">Copy this prompt into any AI</span>
                  </div>
                  <div className="relative rounded-[12px] border border-border-subtle bg-overlay-hover p-4">
                    <p className="m-0 pr-2 text-[13px] leading-[1.6] text-text-secondary">{EXPORT_PROMPT}</p>
                    <div className="mt-2.5 flex justify-end">
                      <button onClick={handleCopy} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-[12px] font-medium" style={{ background: copyState === 'copied' ? 'rgba(16,185,129,0.15)' : 'var(--overlay-strong)', color: copyState === 'copied' ? 'var(--primary)' : 'var(--text-secondary)' }}>
                        {copyState === 'copied' ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>Copied</> : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>Copy</>}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Step 2 */}
                <div>
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-overlay-strong text-[11px] font-bold text-text-primary">2</span>
                    <span className="text-[14px] font-medium text-text-primary">Paste the AI's response here</span>
                  </div>
                  <textarea value={pasteText} onChange={(e) => { setPasteText(e.target.value); setSubmitStatus('idle'); setErrorMsg(''); }} placeholder="Paste the AI's response here…" rows={7} disabled={submitStatus === 'loading'}
                    className="box-border w-full resize-none rounded-[12px] border border-border-subtle bg-overlay-hover px-4 py-3.5 text-[13px] leading-[1.6] text-text-primary caret-primary outline-none [font-family:inherit]" />
                  {errorMsg && <div className="mt-2 text-[12px] text-[#f87171]">{errorMsg}</div>}
                </div>
              </>}
            </div>

            {/* Footer — paste + text tabs */}
            {(tab === 'paste' || tab === 'text') && (
              <div className="flex items-center justify-center gap-2.5 border-t border-border-subtle px-8 pt-4 pb-6">
                <button onClick={onClose} className="cursor-pointer rounded-[12px] border border-border-strong bg-overlay-active px-5 py-2.5 text-[14px] font-medium text-text-primary">
                  Cancel
                </button>
                {tab === 'paste' && (
                  <button onClick={handleAdd} disabled={!hasContent || submitStatus === 'loading'}
                    className="rounded-[12px] border border-border-strong px-5 py-2.5 text-[14px] font-semibold" style={{ cursor: hasContent && submitStatus !== 'loading' ? 'pointer' : 'not-allowed', background: hasContent && submitStatus !== 'loading' ? 'var(--overlay-strong)' : 'var(--overlay-hover)', color: hasContent && submitStatus !== 'loading' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {submitStatus === 'loading' ? 'Adding…' : 'Add to memory'}
                  </button>
                )}
                {tab === 'text' && (
                  <button onClick={handleRawText} disabled={!hasRawText || submitStatus === 'loading'}
                    className="rounded-[12px] border-none px-5 py-2.5 text-[14px] font-semibold" style={{ cursor: hasRawText && submitStatus !== 'loading' ? 'pointer' : 'not-allowed', background: hasRawText && submitStatus !== 'loading' ? 'var(--primary)' : 'var(--overlay-hover)', color: hasRawText && submitStatus !== 'loading' ? 'var(--on-primary)' : 'var(--text-muted)' }}>
                    {submitStatus === 'loading' ? 'Importing…' : 'Add to memory'}
                  </button>
                )}
              </div>
            )}
          </>
        )}
    </Modal>
  );
}
