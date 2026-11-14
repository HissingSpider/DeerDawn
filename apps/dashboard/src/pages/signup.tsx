import ClerkAuthPage from '@/components/ClerkAuthPage';
import { CredentialAuthPage } from '@/components/CredentialAuthPage';
import type { GetServerSidePropsContext } from 'next';
import { useRouter } from 'next/router';
import { siteConfig } from '@/lib/siteConfig';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { authQueryWithClerkHash, resolveAuthReturnPath } from '@/lib/redirects';

export default function Signup() {
  const router = useRouter();
  const { account_type, plan, billing, referral_code, promo_code, campaign } = router.query as {
    account_type?: string; plan?: string; billing?: string;
    referral_code?: string; promo_code?: string; campaign?: string;
  };

  // Bug 2 fix: previously this always rendered AuthPage (custom email+password)
  // even in Clerk mode. The server-side redirect only fires on full navigations —
  // shallow routing from ClerkAuthPage.toggleMode bypassed it, landing users on
  // the wrong form. Render ClerkAuthPage client-side when Clerk is active.
  if (isClerkHostedAuthEnabled()) {
    const params = new URLSearchParams();
    if (account_type) params.set('account_type', account_type);
    if (plan) params.set('plan', plan);
    if (billing) params.set('billing', billing);
    if (referral_code) params.set('referral_code', referral_code);
    if (promo_code) params.set('promo_code', promo_code);
    if (campaign) params.set('campaign', campaign);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    // A sign-up started from an authorize screen must come back to it, or the
    // new account lands on onboarding and the connection it was created for is
    // lost. Otherwise, the usual value-first onboarding.
    const returnTo = resolveAuthReturnPath(
      authQueryWithClerkHash(router.query, typeof window !== 'undefined' ? window.location.hash : ''),
      typeof window !== 'undefined' ? window.location.origin : null,
      'signup',
    );
    const defaultSignupRedirect = returnTo || (plan ? `/checkout${suffix}` : `/onboarding${suffix}`);
    return (
      <ClerkAuthPage
        initialMode="signup"
        redirectUrl={defaultSignupRedirect}
        accountType={account_type}
        plan={plan}
        billing={billing}
        referralCode={referral_code}
        promotionCode={promo_code}
        campaign={campaign}
        returnTo={returnTo}
      />
    );
  }

  // No Clerk (local dev / self-hosted): API email+password sign-up so local
  // end-to-end testing can create an account and land in the dashboard.
  // The return path is carried through as on the Clerk branch, so an invitee
  // comes back to /invite and the sign-up can present the invitation token
  // (a self-host in SIGNUP_MODE=invite_only refuses one without it).
  const credentialReturnTo = resolveAuthReturnPath(
    authQueryWithClerkHash(router.query, typeof window !== 'undefined' ? window.location.hash : ''),
    typeof window !== 'undefined' ? window.location.origin : null,
    'signup',
  );
  return <CredentialAuthPage initialMode="signup" redirectUrl={credentialReturnTo || '/'} />;
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  // Keep server-side redirect as a safety net for non-JS environments and
  // direct server navigations when Clerk is enabled.
  const clerkEnabled = isClerkHostedAuthEnabled();
  if (!clerkEnabled) {
    return { props: {} };
  }

  const query = new URLSearchParams();
  Object.entries(context.query).forEach(([key, value]) => {
    if (typeof value === 'string') query.set(key, value);
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';

  return {
    redirect: {
      destination: `${siteConfig.ACTIVE_SITE_URL}/signup${suffix}`,
      permanent: false,
    },
  };
}
