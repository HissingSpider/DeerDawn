import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { setAddonEnabled } from './platformClient';
import { ADDON_ID, errorText, isAddonDisabled, wardrobe } from './types';

// Actions refuse until Wardrobe is turned on for the workspace. Probe once with
// a cheap read; anything other than "disabled" falls through to the tabs, which
// show their own load errors.
export function EnableGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'disabled' | 'ready'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(() => {
    wardrobe('summary').then(
      () => setState('ready'),
      (err) => setState(isAddonDisabled(err) ? 'disabled' : 'ready'),
    );
  }, []);
  useEffect(() => { probe(); }, [probe]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      await setAddonEnabled(ADDON_ID, true);
      setState('ready');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking') return <Skeleton variant="rectangular" height={280} />;
  if (state === 'disabled') {
    return (
      <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 max-sm:p-4">
        <h2 className="text-base font-semibold text-text-primary">Wardrobe is off</h2>
        <p className="mt-1 max-w-xl text-sm leading-6 text-text-secondary">
          Turn it on to keep a private closet: add photos of your clothes, let your AI put outfits together from them, and save the ones you like under named styles. Only you can see it.
        </p>
        {error ? <p className="mt-3 text-sm text-status-danger">{error}</p> : null}
        <Button className="mt-4" size="sm" isLoading={busy} onClick={() => void enable()}>Turn on Wardrobe</Button>
      </div>
    );
  }
  return <>{children}</>;
}
