import ClerkAuthPage from '@/components/ClerkAuthPage';
import { CredentialAuthPage } from '@/components/CredentialAuthPage';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { useRouter } from 'next/router';
import { authQueryWithClerkHash, resolveAuthReturnPath } from '@/lib/redirects';

export default function Login() {
  const router = useRouter();
  // Bug 7 fix: pass ?redirect_url through to ClerkAuthPage so post-sign-in
  // navigation lands on the originally requested page, not always '/'.
  // Clerk's redirect-mode buttons pass ABSOLUTE return URLs (and a force param
  // beside redirect_url); resolveAuthReturnPath reduces a same-origin one to a
  // path, which is what the authorize screens rely on to get their request back.
  const redirectUrl = resolveAuthReturnPath(
    authQueryWithClerkHash(router.query, typeof window !== 'undefined' ? window.location.hash : ''),
    typeof window !== 'undefined' ? window.location.origin : null,
    'login',
  );

  if (isClerkHostedAuthEnabled()) {
    return <ClerkAuthPage initialMode="login" redirectUrl={redirectUrl} />;
  }

  // No Clerk (local dev / self-hosted): use the API's email+password auth so you
  // can actually sign in and run full end-to-end tests locally.
  return <CredentialAuthPage initialMode="login" redirectUrl={redirectUrl || '/'} />;
}

export async function getServerSideProps() {
  return { props: {} };
}
