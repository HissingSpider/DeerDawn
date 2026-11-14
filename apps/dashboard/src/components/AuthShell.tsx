import Head from 'next/head';
import { BrandLogo } from '@/components/BrandLogo';
import { siteConfig } from '@/lib/siteConfig';
import { useDeployment } from '@/lib/deployment';

interface AuthShellProps {
  title: string;
  subtitle: string;
  mode: 'login' | 'signup';
  children: React.ReactNode;
  alternateAction: React.ReactNode;
}

export default function AuthShell({ title, subtitle, mode, children, alternateAction }: AuthShellProps) {
  const { selfHosted } = useDeployment();
  return (
    <>
      <Head>
        <title>{`${mode === 'signup' ? 'Sign Up' : 'Sign In'} | DeerDawn`}</title>
        <meta name="description" content="AI session memory for professionals switching between AI tools — the brief every new session reads first." />
      </Head>

      <div className="flex min-h-screen items-center justify-center bg-background px-5 py-8 sm:px-6">
        <div className="w-full max-w-[420px]">

          {/* Logo + heading */}
          <div className="mb-6 text-center">
            <div className="mb-5 inline-flex items-center justify-center">
              <div className="relative h-12 w-12 overflow-hidden rounded-lg border border-primary/30 bg-primary/10 shadow-sm">
                <BrandLogo alt="DeerDawn" sizes="48px" priority />
              </div>
            </div>
            <h1 className="mb-2 text-2xl font-semibold text-text-primary">{title}</h1>
            <p className="mx-auto max-w-[22rem] text-sm leading-6 text-text-secondary">{subtitle}</p>
          </div>

          {/* Card */}
          <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-md sm:px-6 sm:py-6">
            {children}
            {/* Where Clerk renders an escalated bot-protection challenge. Without
                this element Clerk silently opts into the invisible captcha, and a
                sign-up it escalates can never complete (the marketing site's
                _app.tsx records the same finding). Renders nothing unless Clerk
                fills it. Not the cause of the Google -> /login loop; that was
                AuthProvider guarding /oauth/sso-callback (see _app.tsx). */}
            <div id="clerk-captcha" />
          </div>

          <div className="mt-5 text-center text-sm text-text-secondary">
            {alternateAction}
          </div>

          {/* A self-hosted install has no marketing site to go back to. */}
          {selfHosted ? null : (
          <div className="mt-3 text-center">
            <a
              href={siteConfig.ACTIVE_SITE_URL}
              className="ui-press ui-focus inline-flex h-10 items-center gap-2 rounded-lg border border-border-subtle bg-overlay-subtle px-4 text-sm text-text-secondary no-underline transition-colors hover:border-border hover:bg-overlay-hover hover:text-text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              Back to deerdawn.com
            </a>
          </div>
          )}
        </div>
      </div>
    </>
  );
}
