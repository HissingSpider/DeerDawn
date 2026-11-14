import { useState } from 'react';
import { BlockingBanner } from '@/components/dashboard/brief/BlockingBanner';

/**
 * Dev-only visual harness for <BlockingBanner> so its light/dark rendering can be
 * eyeballed without signing in (the real dashboard gates every view behind the
 * bootstrap session fetch). Rendered outside Layout via the /dev/ bypass in
 * _app.tsx, and 404'd in production by getServerSideProps below.
 *
 * Not linked from anywhere — reach it directly at /dev/blocking-banner.
 */
export default function BlockingBannerPreview() {
  // Re-mount the active banner so you can replay the "Mark completed" flip.
  const [key, setKey] = useState(0);

  return (
    <div className="min-h-full bg-background px-6 py-10 text-text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Dev preview</p>
            <h1 className="mt-1 text-xl font-semibold text-text-primary">BlockingBanner</h1>
          </div>
          <button
            onClick={() => setKey((k) => k + 1)}
            className="rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            Reset
          </button>
        </header>

        <section className="flex flex-col gap-3">
          <p className="text-[12px] font-medium text-text-secondary">Active — blocking</p>
          <BlockingBanner
            key={key}
            text="API key rotation is overdue. Connected services will start returning 401s once the current key expires."
            onComplete={() => { /* preview: no persistence */ }}
          />
          <p className="text-[12px] text-text-muted">
            Click &ldquo;Mark completed&rdquo; above to see the completed (emerald) state.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <p className="text-[12px] font-medium text-text-secondary">Short text</p>
          <BlockingBanner text="Deploy blocked on failing CI." onComplete={() => {}} />
        </section>
      </div>
    </div>
  );
}

// Never ship this route to production.
export async function getServerSideProps() {
  if (process.env.NODE_ENV === 'production') {
    return { notFound: true };
  }
  return { props: {} };
}
