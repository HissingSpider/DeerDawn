import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { api, setActiveWorkspace } from '@/lib/api';
import { useSafeSignOut } from '@/lib/useSafeSignOut';
import {
  planForbiddenWorkspaceExit,
  forbiddenWorkspaceCopy,
  type ForbiddenWorkspaceExit,
} from '@/lib/workspaceRecovery';

/**
 * The `workspace_forbidden` screen's actions.
 *
 * The state it replaces offered Retry alone, which for a legacy member whose
 * home org IS the team is a button that cannot succeed — the stored workspace
 * has already been dropped and the account default resolves to the same
 * forbidden key. See lib/workspaceRecovery.ts for why the answer is a listing
 * rather than a retry.
 *
 * Signing out is the exit of last resort and has to be said out loud: the reader
 * is still signed in, so /login would otherwise see a live session and send them
 * straight back — the loop this whole screen exists to break.
 */
export function WorkspaceForbiddenExit({ description }: { description: string }) {
  const router = useRouter();
  const signOut = useSafeSignOut();
  const [exit, setExit] = useState<ForbiddenWorkspaceExit | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // GET /teams/workspaces is the one route a barred member can still reach —
    // it answers "where may I go", which is the question this screen is asking.
    api.getWorkspaces()
      .then((listing) => { if (!cancelled) setExit(planForbiddenWorkspaceExit(listing)); })
      .catch(() => { if (!cancelled) setExit(planForbiddenWorkspaceExit(null)); });
    return () => { cancelled = true; };
  }, []);

  const switchTo = useCallback(async (workspace: string) => {
    setBusy(true);
    // Locally first, so the next request carries the new workspace even if the
    // server-side persist fails; that call is best-effort for the same reason
    // the switcher treats it as one.
    setActiveWorkspace(workspace);
    await api.setActiveWorkspaceOnServer(workspace).catch(() => undefined);
    router.reload();
  }, [router]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await signOut({ redirectUrl: '/login' });
    } catch {
      router.push('/login');
    }
  }, [signOut, router]);

  const copy = exit ? forbiddenWorkspaceCopy(exit) : null;

  return (
    <>
      <p className="mb-6 text-[13px] leading-[1.6] text-text-muted">
        {copy?.description || description}
      </p>
      {!exit && (
        <p className="text-[13px] text-text-muted">Checking which workspaces you can open…</p>
      )}
      {exit?.kind === 'switch' && (
        <div className="flex flex-col gap-2">
          {exit.options.map((option) => (
            <button
              key={option.workspace}
              type="button"
              disabled={busy}
              onClick={() => switchTo(option.workspace)}
              className="inline-flex cursor-pointer items-center justify-center rounded-[10px] border-none px-7 py-2.5 text-[13px] font-semibold"
              style={{ background: 'var(--primary)', color: 'var(--on-primary)' }}
            >
              {`Open ${option.name}`}
            </button>
          ))}
        </div>
      )}
      {exit?.kind === 'sign_out' && (
        <button
          type="button"
          disabled={busy}
          onClick={handleSignOut}
          className="inline-flex cursor-pointer items-center justify-center rounded-[10px] border-none px-7 py-2.5 text-[13px] font-semibold"
          style={{ background: 'var(--primary)', color: 'var(--on-primary)' }}
        >
          {copy?.actionLabel || 'Sign out'}
        </button>
      )}
    </>
  );
}
