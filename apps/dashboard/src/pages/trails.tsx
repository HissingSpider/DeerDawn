import { PRO_PLAN_NAME } from '@/lib/planCopy';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  isApiError,
  ShareScanError,
  type ContextProjectSummary,
  type ShareLink,
  type ShareScan,
  type ShareScanFinding,
} from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { InlineErrorState } from '@/components/dashboard/PageScaffold';
import { RefusalNotice, loadFailureFrom } from '@/components/dashboard/RefusalNotice';
import { isRefusedLoad, type LoadFailure } from '@/lib/loadFailure';
import { siteConfig } from '@/lib/siteConfig';
import { EyeOffIcon, GlobeIcon, LinkIcon } from '@/components/icons';
import { MAX_TRAIL_BYTES_CEILING, describeTrailTooLarge, trailTooLarge } from '@/lib/trailLimits';

function shareUrl(token: string) {
  return `${siteConfig.ACTIVE_SITE_URL}/s/${token}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

// The scan's output, laid out so it can actually be acted on: grouped by
// severity, each finding naming the slot it came from and quoting the excerpt.
// A refusal that doesn't say what it objected to is unactionable, so this is not
// optional chrome — it is the other half of the gate.
function ScanFindings({
  scan,
  acknowledged,
  onToggle,
}: {
  scan: ShareScan;
  acknowledged: Set<string>;
  onToggle: (id: string) => void;
}) {
  const order: ShareScanFinding['severity'][] = ['high', 'medium', 'low'];
  const tone: Record<ShareScanFinding['severity'], string> = {
    high: 'text-status-danger',
    medium: 'text-status-warning',
    low: 'text-text-muted',
  };

  return (
    <div className="mt-4 rounded-lg border border-border-subtle">
      <div className="border-b border-border-subtle px-4 py-3 text-[13px] text-text-secondary">
        The scan reads the brief itself, not your repo. A brief legitimately contains what is
        broken and what you owe yourself later — review each line before it leaves your account.
      </div>
      {order.flatMap((severity) => scan.findings.filter((f) => f.severity === severity)).map((finding) => (
        <label
          key={finding.id}
          className="flex cursor-pointer items-start gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0"
        >
          <input
            type="checkbox"
            checked={acknowledged.has(finding.id)}
            onChange={() => onToggle(finding.id)}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${tone[finding.severity]}`}>
                {finding.severity}
              </span>
              <span className="text-xs text-text-muted">{finding.category.replace(/_/g, ' ')}</span>
              <span className="text-xs text-text-muted">· {finding.section}</span>
            </span>
            <span className="mt-1 block break-words font-mono text-xs text-text-secondary">
              {finding.excerpt}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

function CreateShare({ projects, onCreated }: { projects: ContextProjectSummary[]; onCreated: () => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.project_id ?? '');
  const [visibility, setVisibility] = useState<'unlisted' | 'public'>('unlisted');
  const [scan, setScan] = useState<ShareScan | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Preview up front rather than waiting for a refusal: the scan is part of
  // deciding whether to share at all, not a hurdle discovered after committing.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setScan(null);
    setAcknowledged(new Set());
    setMessage(null);
    api.previewShare(projectId)
      .then((result) => { if (!cancelled) setScan(result.scan); })
      .catch(() => { if (!cancelled) setMessage('Couldn’t scan this brief. Try again.'); });
    return () => { cancelled = true; };
  }, [projectId]);

  const unresolved = scan ? scan.findings.filter((f) => !acknowledged.has(f.id)).length : 0;

  const create = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.createShareLink(projectId, {
        visibility,
        acknowledged_finding_ids: [...acknowledged],
      });
      onCreated();
      setMessage('Link created.');
    } catch (err) {
      if (err instanceof ShareScanError) {
        setScan(err.scan);
        setMessage(err.message);
      } else {
        setMessage(err instanceof Error ? err.message : 'Couldn’t create the link.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-elevated p-5 max-sm:p-4">
      <h2 className="text-sm font-semibold text-text-primary">Share a brief</h2>
      <p className="mt-1 text-[13px] leading-5 text-text-secondary">
        A share link opens the four slots — shipped, decided, open, will bite you — on a public
        page with no sign-in and no dashboard around it.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5">
          <span className="text-xs text-text-muted">Project</span>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary focus:border-border-strong focus:outline-none"
          >
            {projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>{project.project_name}</option>
            ))}
          </select>
        </label>

        <label className="grid gap-1.5">
          <span className="text-xs text-text-muted">Visibility</span>
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as 'unlisted' | 'public')}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary focus:border-border-strong focus:outline-none"
          >
            <option value="unlisted">Unlisted — anyone with the link</option>
            <option value="public">Public — listed and indexable</option>
          </select>
        </label>

        <button
          type="button"
          onClick={create}
          disabled={busy || !projectId || !scan || unresolved > 0}
          className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50 hover:bg-primary/90"
        >
          {busy ? 'Creating…' : 'Create link'}
        </button>
      </div>

      {scan === null ? (
        <p className="mt-4 text-[13px] text-text-muted">Scanning this brief…</p>
      ) : scan.findings.length === 0 ? (
        <p className="mt-4 text-[13px] text-primary">Scan found nothing to review.</p>
      ) : (
        <>
          <p className="mt-4 text-[13px] text-text-secondary">
            {unresolved > 0
              ? `${unresolved} of ${scan.findings.length} still to review.`
              : `All ${scan.findings.length} reviewed.`}
          </p>
          <ScanFindings
            scan={scan}
            acknowledged={acknowledged}
            onToggle={(id) => setAcknowledged((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })}
          />
        </>
      )}

      {message ? <p className="mt-3 text-[13px] text-text-secondary">{message}</p> : null}
    </section>
  );
}

function ShareRow({ share, onChanged }: { share: ShareLink; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = share.token ? shareUrl(share.token) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Couldn’t copy. Select the link and copy it manually.');
    }
  };

  const toggleVisibility = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!share.token) return;
      await api.setShareVisibility(share.token, share.visibility === 'public' ? 'unlisted' : 'public');
      onChanged();
    } catch (err) {
      // Going public re-runs the scan against the brief as it is NOW. Send the
      // owner back to the create flow rather than silently failing here.
      setError(err instanceof ShareScanError
        ? `${err.message} Review them above before making this public.`
        : 'Couldn’t change visibility.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!share.token) return;
      await api.revokeShareLink(share.token);
      onChanged();
    } catch {
      setError('Couldn’t revoke the link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border-subtle px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
          {share.visibility === 'public' ? <GlobeIcon size={14} /> : <EyeOffIcon size={14} />}
          {share.visibility}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {share.project_name || share.project_id}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-text-muted">
          {share.view_count} {share.view_count === 1 ? 'view' : 'views'} · {formatDate(share.created_at)}
        </span>
      </div>
      {!share.token ? (
        <p className="mt-2 text-xs text-text-muted">
          Only the person who created this link, or a workspace owner, can copy or change it.
        </p>
      ) : (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <code className="min-w-0 flex-1 truncate rounded bg-overlay-subtle px-2 py-1 font-mono text-xs text-text-secondary">
          {url}
        </code>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          <LinkIcon size={14} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={toggleVisibility} disabled={busy} className="text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
          Make {share.visibility === 'public' ? 'unlisted' : 'public'}
        </button>
        <button type="button" onClick={revoke} disabled={busy} className="text-xs font-medium text-status-danger hover:opacity-80 disabled:opacity-50">
          Revoke
        </button>
      </div>
      )}
      {error ? <p className="mt-2 text-xs text-status-warning">{error}</p> : null}
    </div>
  );
}

// Trails — where a brief becomes a URL somebody else can read. The share link is
// the growth loop, the proof of value and the Team demo in one route, which is
// also exactly why the scan gate sits in front of it.
/**
 * Import a .dawn Trail from the browser.
 *
 * The endpoint has existed for a while and needs only an account — no MCP, no
 * install — but there was no control anywhere in the UI, so the capability was
 * unreachable to exactly the users it suits: signed in, nothing connected yet.
 *
 * Imports dry-run FIRST. A Trail can conflict with an existing project, and
 * finding that out after the write is not a recoverable position for a user who
 * cannot see what changed.
 */
function ImportTrail({ onImported }: { onImported: () => void }) {
  const [fileName, setFileName] = useState('');
  const [contents, setContents] = useState('');
  const [projectName, setProjectName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = async (file: File | undefined) => {
    setError(null);
    setResult(null);
    if (!file) return;
    // A .dawn is JSON-ish text. Reading it here rather than posting a multipart
    // upload keeps the endpoint's existing contract (it takes contents).
    //
    // SIZED AGAINST WHAT THE IMPORT ACCEPTS. This used to refuse at 5 MB while
    // the API caps the trail at 200,000 characters, so everything in between
    // was uploaded and came back a raw Zod 400 — against a limit this page had
    // already told the user was twenty-five times higher.
    //
    // Bytes first, only as a shortcut past files that cannot fit under any
    // encoding; the real measurement is on the characters the server counts.
    if (file.size > MAX_TRAIL_BYTES_CEILING) {
      setError(describeTrailTooLarge());
      return;
    }
    try {
      const text = await file.text();
      if (trailTooLarge(text.length)) {
        setError(describeTrailTooLarge(text.length));
        return;
      }
      setFileName(file.name);
      setContents(text);
      if (!projectName) setProjectName(file.name.replace(/\.dawn$/i, '').slice(0, 60));
    } catch {
      setError('Could not read that file.');
    }
  };

  const run = async () => {
    if (!contents || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Plan first, so a conflicting Trail is reported rather than applied.
      const plan = await api.importTrail(contents, { newProjectName: projectName || undefined, dryRun: true });
      if (Array.isArray(plan.conflicts) && plan.conflicts.length > 0) {
        setError(`That Trail conflicts with existing context in ${plan.conflicts.length} place(s). Import it into a new project name instead.`);
        return;
      }
      const applied = await api.importTrail(contents, { newProjectName: projectName || undefined });
      if (!applied.applied) {
        setError('The import did not apply. Nothing was changed.');
        return;
      }
      setResult(`Imported into ${applied.project_name || projectName || 'a new project'}.`);
      setContents('');
      setFileName('');
      if (inputRef.current) inputRef.current.value = '';
      onImported();
    } catch (err) {
      // A timeout is not a failure report: the write may still land. Saying
      // "failed" invites a retry, and a retry imports the Trail twice.
      if (isApiError(err) && err.code === 'network_timeout') {
        setError('The import is taking longer than expected and may still finish. Check Projects before trying again, so it is not imported twice.');
        onImported();
        return;
      }
      const message = isApiError(err) ? err.message : 'Import failed.';
      setError(message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-elevated p-5 max-sm:p-4">
      <h2 className="text-sm font-semibold text-text-primary">Import a Trail</h2>
      <p className="mt-1 text-[13px] leading-6 text-text-secondary">
        Bring a <code className="text-text-primary">.dawn</code> archive in as a project. Nothing to install.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".dawn,application/json,text/plain"
          onChange={(e) => pick(e.target.files?.[0])}
          className="text-[13px] text-text-secondary file:mr-3 file:rounded-md file:border file:border-border-subtle file:bg-overlay-hover file:px-3 file:py-1.5 file:text-[13px] file:text-text-primary hover:file:bg-overlay-strong"
        />
        {fileName ? <span className="text-xs text-text-muted">{fileName}</span> : null}
      </div>

      <label className="mt-4 block text-xs font-medium text-text-muted" htmlFor="trail-project-name">
        Project name
      </label>
      <input
        id="trail-project-name"
        value={projectName}
        onChange={(e) => setProjectName(e.target.value)}
        placeholder="Where it should land"
        className="mt-1 w-full max-w-sm rounded-md border border-border-subtle bg-overlay-hover px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-primary/40 focus:outline-none"
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={!contents || busy}
          className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
        {error ? <span className="text-[13px] text-status-danger">{error}</span> : null}
        {result ? <span className="text-[13px] text-text-secondary">{result}</span> : null}
      </div>
    </section>
  );
}

export default function TrailsPage() {
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [projects, setProjects] = useState<ContextProjectSummary[] | null>(null);
  const [locked, setLocked] = useState(false);
  // A failed list used to be written as `[]`, which rendered "No share links
  // yet." — the worst possible lie on this page: a live public link is still
  // serving a brief, and the one screen that could revoke it says there is
  // nothing to revoke.
  const [listError, setListError] = useState<Error | null>(null);
  // And a REFUSED list (the workspace's subscription is inactive) is neither
  // empty nor "didn't load": lib/loadFailure says which it was.
  const [listRefusal, setListRefusal] = useState<LoadFailure | null>(null);

  // `locked` comes from the server's can_create flag, not from catching a 403.
  // Listing is deliberately ungated, so a free account gets a perfectly
  // successful empty list — inferring entitlement from a failed request meant
  // the locked panel could never render and free users met the create form
  // instead, only to be refused on submit.
  const load = useCallback(() => {
    setListError(null);
    setListRefusal(null);
    api.getShareLinks()
      .then(({ can_create, shares: list }) => {
        setLocked(!can_create);
        setShares(list);
        setListError(null);
      })
      .catch((err: unknown) => {
        // `shares` stays null: there is no list to show, and showing an empty
        // one would be an answer we do not have.
        setShares(null);
        void loadFailureFrom(err).then((failure) => {
          if (isRefusedLoad(failure)) setListRefusal(failure);
          else setListError(isApiError(err) ? err : new Error('share_links_load_failed'));
        });
      });
  }, []);

  useEffect(() => {
    load();
    api.getContextProjects().then(setProjects).catch(() => setProjects([]));
  }, [load]);

  return (
    <>
      <Head><title>Trails | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {locked ? (
          <section className="rounded-xl border border-primary/25 bg-primary/[0.05] p-5 max-sm:p-4">
            <p className="text-base leading-6 text-text-primary">Share links are part of {PRO_PLAN_NAME}.</p>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              Your projects and briefs stay unlimited on Free, and you can export any brief at any
              time without a share link.
            </p>
            <Link
              href="/settings/plan"
              className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90"
            >
              See {PRO_PLAN_NAME}
            </Link>
          </section>
        ) : projects && projects.length > 0 ? (
          <CreateShare projects={projects} onCreated={load} />
        ) : null}

        {/* Ungated on purpose: importing is not a paid action, and it is one of
            the only things a signed-in user with nothing connected can do. */}
        <ImportTrail onImported={() => { load(); api.getContextProjects().then(setProjects).catch(() => {}); }} />

        <section>
          <h2 className="mb-2 text-xs font-medium text-text-muted">Your share links</h2>
          {listRefusal ? (
            <RefusalNotice failure={listRefusal} />
          ) : listError ? (
            <InlineErrorState
              title="Couldn't load your share links"
              description="Any links you have made are still live — this list just didn't load, so nothing here can be trusted as complete."
              onRetry={load}
              requestId={isApiError(listError) ? listError.requestId : undefined}
            />
          ) : shares === null ? (
            <Skeleton variant="rectangular" height={120} />
          ) : shares.length === 0 ? (
            <div className="rounded-xl border border-border-subtle px-4 py-6 text-center text-sm text-text-muted">
              No share links yet.
            </div>
          ) : (
            <div className="rounded-xl border border-border-subtle">
              {shares.map((share) => (
                <ShareRow key={share.token || share.ref_code || `${share.project_id}:${share.created_at}`} share={share} onChanged={load} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
