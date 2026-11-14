import { useClerk } from '@clerk/nextjs';

// Clerk runs only in production (live publishable keys are domain-locked), so in
// dev/local the dashboard renders without a <ClerkProvider>. useClerk() throws when
// there's no provider — guard it so the shell still renders and sign-out falls back
// to a plain redirect. The throw is deterministic per environment (always in dev,
// never in prod), so the hook order stays stable across renders.
export function useSafeSignOut(): (opts?: { redirectUrl?: string }) => void | Promise<void> {
  try {
    // The throw is deterministic per environment (always in dev where no
    // <ClerkProvider> mounts, never in prod), so React's hook order is stable
    // across renders even though this try/catch looks conditional to the linter.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { signOut } = useClerk();
    return (opts) => signOut(opts);
  } catch {
    return (opts) => {
      if (typeof window !== 'undefined') window.location.href = opts?.redirectUrl ?? '/login';
    };
  }
}
