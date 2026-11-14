import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { api, apiErrorReason, isApiError } from '@/lib/api';
import { describeClosedWorkspaces, describeTeamWorkThatStays, EXPORT_ALSO_CLOSED_WORKSPACES, exportNotSentNotice, type ClosedWorkspace } from '@/lib/accountClose';

// Intense, irreversible-action confirmation for account deletion. Unlike the
// generic ConfirmDialog (a yes/no), this requires the user to re-prove identity:
// a password (the common case), or — for OAuth-only accounts with no password —
// typing their exact email. A pre-checked box also emails them a full .md export
// of their context before the data is wiped.
export function DeleteAccountDialog({
  email,
  onCancel,
  onDeleted,
}: {
  email: string;
  onCancel: () => void;
  /** Called after the account is deleted server-side; parent signs out + redirects. */
  onDeleted: (result: { export_emailed: boolean; closed_workspaces: ClosedWorkspace[] }) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [emailExport, setEmailExport] = useState(true);
  // Password is the default proof; we fall back to email confirmation only if the
  // server tells us this account has no password (OAuth-only).
  const [mode, setMode] = useState<'password' | 'email'>('password');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set when the export was asked for and could not be emailed: nothing was
  // deleted, and the person may retry or turn the export off.
  const [exportError, setExportError] = useState<string | null>(null);
  // Set once the account is gone AND other workspaces closed with it: those are
  // named before the parent signs out and leaves, because the toast it shows
  // does not survive the redirect, and the person may not remember them.
  const [closedResult, setClosedResult] = useState<{ export_emailed: boolean; closed_workspaces: ClosedWorkspace[] } | null>(null);
  // The teams this person is in, from the workspace listing: their shared and
  // private projects stay with those teams, and the dialog says so, by name,
  // before anything is deleted. Nothing is added while it loads or if it fails.
  const [teamWorkStays, setTeamWorkStays] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then((listing) => { if (!cancelled) setTeamWorkStays(describeTeamWorkThatStays(listing?.workspaces)); })
      .catch(() => { /* the dialog says what it always said */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // After the delete there is nothing to cancel: dismissing is finishing.
      if (closedResult) onDeleted(closedResult);
      else if (!submitting) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onDeleted, submitting, closedResult]);

  const canSubmit = mode === 'password' ? password.length > 0 : confirmEmail.trim().length > 0;

  async function handleDelete() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    setExportError(null);
    try {
      const result = await api.deleteOrg({
        email_export: emailExport,
        ...(mode === 'password' ? { password } : { confirm_email: confirmEmail }),
      });
      const done = {
        export_emailed: result.export_emailed,
        closed_workspaces: Array.isArray(result.closed_workspaces) ? result.closed_workspaces : [],
      };
      if (done.closed_workspaces.length) {
        setClosedResult(done);
        setSubmitting(false);
        return;
      }
      onDeleted(done);
    } catch (err) {
      const notSent = exportNotSentNotice(apiErrorReason(err), isApiError(err) ? err.message : null);
      if (notSent) {
        setExportError(notSent);
      } else if (isApiError(err) && err.code === 'email_confirmation_required') {
        // Already confirming by email → the typed email didn't match. Otherwise
        // this is an OAuth-only account with no password: switch to email mode.
        setError(
          mode === 'email'
            ? 'That doesn’t match your account email. Please try again.'
            : 'This account signs in without a password. Type your account email below to confirm.',
        );
        setMode('email');
      } else if (isApiError(err) && err.code === 'invalid_password') {
        setError('Incorrect password. Please try again.');
      } else if (isApiError(err) && err.code === 'password_required') {
        setError('Enter your password to confirm.');
      } else {
        setError(isApiError(err) ? err.message : 'Could not delete your account. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dd-delete-title"
      onMouseDown={() => {
        if (closedResult) onDeleted(closedResult);
        else if (!submitting) onCancel();
      }}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(3,7,18,0.72)] p-4 backdrop-blur-[12px]"
    >
      <div
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] rounded-2xl border border-red-500/20 bg-surface-elevated p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        {closedResult ? (
          <>
            <h2 id="dd-delete-title" className="m-0 text-lg font-semibold text-text-primary">
              Account deleted
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {describeClosedWorkspaces(closedResult.closed_workspaces)}
            </p>
            {closedResult.export_emailed ? (
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                Your context export is on its way by email.
              </p>
            ) : null}
            <div className="mt-6 flex items-center justify-end">
              <Button variant="secondary" size="sm" onClick={() => onDeleted(closedResult)}>
                Done
              </Button>
            </div>
          </>
        ) : (
        <>
        <h2 id="dd-delete-title" className="m-0 text-lg font-semibold text-text-primary">
          Delete your account?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          This <strong className="text-text-primary">permanently</strong> deletes your account and all synced
          context across every project. Any other workspace you are the only member of is closed too, and its
          subscription cancelled. This cannot be undone.
        </p>
        {teamWorkStays ? (
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{teamWorkStays}</p>
        ) : null}

        {/* Pre-checked data-portability courtesy. */}
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-border-subtle bg-overlay-subtle p-3">
          <input
            type="checkbox"
            checked={emailExport}
            onChange={(e) => setEmailExport(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="text-xs leading-relaxed text-text-secondary">
            Email me a full export of my context (<code className="text-primary/80">.md</code>) to{' '}
            <span className="text-text-primary">{email}</span> before deleting. {EXPORT_ALSO_CLOSED_WORKSPACES}
          </span>
        </label>
        {exportError ? (
          <p role="alert" className="mt-2 text-sm leading-relaxed text-red-400">{exportError}</p>
        ) : null}

        {/* Step-up re-authentication. */}
        <div className="mt-4">
          {mode === 'password' ? (
            <Input
              ref={firstFieldRef}
              type="password"
              label="Confirm your password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error ?? undefined}
              fullWidth
              required
            />
          ) : (
            <Input
              ref={firstFieldRef}
              type="email"
              label="Type your account email to confirm"
              autoComplete="off"
              placeholder={email}
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              error={error ?? undefined}
              fullWidth
              required
            />
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            disabled={!canSubmit}
            isLoading={submitting}
          >
            {exportError ? 'Try again' : 'Delete account'}
          </Button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
