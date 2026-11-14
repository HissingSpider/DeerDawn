import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { PageScaffold, InlineErrorState } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { isApiError } from '@/lib/api';
import { listAddons, setAddonEnabled, type AddonCatalogEntry } from '@/lib/addonsApi';

// The add-on catalog for the current workspace. Switching one on is a
// workspace setting (an owner's call in a team); the data an add-on keeps is
// always personal, so nobody else in the workspace sees yours.

export default function AddonsPage() {
  const [addons, setAddons] = useState<AddonCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listAddons()
      .then((list) => { if (!cancelled) setAddons(list); })
      .catch((err) => { if (!cancelled) setError(isApiError(err) ? err.message : 'The add-ons could not be loaded.'); });
    return () => { cancelled = true; };
  }, [attempt]);

  const toggle = useCallback(async (addon: AddonCatalogEntry) => {
    setBusy(addon.id);
    setActionError(null);
    try {
      const updated = await setAddonEnabled(addon.id, !addon.enabled);
      setAddons((list) => (list || []).map((a) => (a.id === addon.id ? { ...a, enabled: updated.enabled } : a)));
    } catch (err) {
      setActionError(isApiError(err) ? err.message : 'That change did not go through.');
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <>
      <Head><title>Add-ons | DeerDawn</title></Head>
      <PageScaffold
        title="Add-ons"
        description="Extra kinds of memory for your agent, kept apart from your project briefs. What an add-on stores is private to you, even in a team workspace."
      >
        {error ? (
          <InlineErrorState title="Add-ons did not load" description={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : null}
        {actionError ? (
          <p role="alert" className="text-sm text-status-danger">{actionError}</p>
        ) : null}
        {!addons && !error ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}
        {addons && addons.length === 0 ? (
          <p className="text-sm text-text-secondary">This server has no add-ons installed.</p>
        ) : null}
        {addons && addons.length > 0 ? (
          <ul className="space-y-3">
            {addons.map((addon) => (
              <li key={addon.id} className="rounded-2xl border border-border-subtle bg-surface p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-text-primary">{addon.name}</h2>
                      <span className="text-xs text-text-muted">v{addon.version}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${addon.enabled
                          ? 'border-primary/40 text-primary'
                          : 'border-border-subtle text-text-muted'}`}
                      >
                        {addon.enabled ? 'On' : 'Off'}
                      </span>
                    </div>
                    {addon.description ? <p className="text-sm leading-6 text-text-secondary">{addon.description}</p> : null}
                    <p className="text-xs text-text-muted">
                      Your agent reaches it through read_addon and use_addon with addon &quot;{addon.id}&quot;.
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {addon.enabled ? (
                      <Link href={`/addons/${encodeURIComponent(addon.id)}`} className="text-sm font-medium text-primary hover:underline">
                        Open
                      </Link>
                    ) : null}
                    <Button
                      size="sm"
                      variant={addon.enabled ? 'secondary' : 'primary'}
                      isLoading={busy === addon.id}
                      onClick={() => toggle(addon)}
                    >
                      {addon.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </PageScaffold>
    </>
  );
}
