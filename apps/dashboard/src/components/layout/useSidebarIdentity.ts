import { useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { api, type OrgUsageSummary, type CurrentUser } from '@/lib/api';
import { logger } from '@/lib/logger';

type SidebarIdentity = {
  email: string;
  orgName: string;
};

const DEFAULT_IDENTITY: SidebarIdentity = {
  email: '',
  orgName: '',
};

// Clerk's useUser() throws ("can only be used within <ClerkProvider>") when no
// provider is mounted. The provider is only mounted in production builds, so in
// local dev (no Clerk) calling it crashes the whole dashboard shell. Guard it
// behind the same build-time flag that decides whether Clerk is active: when
// Clerk is enabled (production) we call useUser() exactly as before; when it is
// not (local dev) we skip it and fall back to the password/API identity path.
// The flag is derived from a NEXT_PUBLIC_* env var, inlined at build time and
// constant for the app's lifetime, so this conditional hook call keeps a stable
// hook order across renders.
function useClerkUserSafe(isClerkEnabled: boolean): { user: ReturnType<typeof useUser>['user']; isUserLoaded: boolean } {
  if (!isClerkEnabled) {
    return { user: null, isUserLoaded: true };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { user, isLoaded } = useUser();
  return { user, isUserLoaded: isLoaded };
}

export function useSidebarIdentity(isClerkEnabled: boolean): SidebarIdentity {
  const [identity, setIdentity] = useState<SidebarIdentity>(DEFAULT_IDENTITY);
  const { user, isUserLoaded } = useClerkUserSafe(isClerkEnabled);

  useEffect(() => {
    let cancelled = false;

    async function loadUsageIdentity() {
      try {
        const usage: OrgUsageSummary = await api.getUsage();
        if (!cancelled && usage.org_name) {
          setIdentity((current) => ({ ...current, orgName: usage.org_name || current.orgName }));
        }
      } catch (error) {
        logger.error('sidebar_identity_usage_failed', error);
      }
    }

    async function loadApiIdentity() {
      try {
        const currentUser: CurrentUser = await api.getCurrentUser();
        if (cancelled) return;
        setIdentity({
          email: currentUser.email || 'Operator',
          orgName: currentUser.org_name || '',
        });
      } catch (error) {
        logger.error('sidebar_identity_user_failed', error);
      }
    }

    if (isClerkEnabled) {
      if (!isUserLoaded || !user) return undefined;
      setIdentity({
        email: user.primaryEmailAddress?.emailAddress || 'Operator',
        orgName: '',
      });
      void loadUsageIdentity();
    } else {
      void loadApiIdentity();
    }

    return () => {
      cancelled = true;
    };
  }, [isClerkEnabled, isUserLoaded, user]);

  return identity;
}
