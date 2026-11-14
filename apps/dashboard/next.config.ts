import path from 'node:path';
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const brandMode = process.env.NEXT_PUBLIC_BRAND_MODE === 'governance' ? 'governance' : 'primary';
const governanceAppUrl = (process.env.NEXT_PUBLIC_GOVERNANCE_APP_URL || 'https://app.governance.deerdawn.com').replace(/\/+$/, '');

const isProd = process.env.NODE_ENV === "production";

const scriptSrc = [
  "script-src 'self'",
  ...(isProd ? [] : ["'unsafe-eval'"]),
  "https://*.clerk.com",
  "https://*.clerk.dev",
  "https://*.clerk.accounts.dev",
  "https://clerk.deerdawn.com",
  "https://clerk.app.deerdawn.com",
  "https://challenges.cloudflare.com",
  "https://static.cloudflareinsights.com",
  // Google Ads + GA4: gtag.js loader (googletagmanager) + Ads conversion scripts.
  "https://www.googletagmanager.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
  // PostHog: SDK + autocapture assets (us-assets.i.posthog.com).
  "https://*.posthog.com",
  // Reddit Pixel: the /rdt-init.js bootstrap injects pixel.js from redditstatic.
  "https://www.redditstatic.com",
].join(" ");

// The API this build talks to. A self-hosted install serves it from its own
// origin, which the hosted list below cannot name, so it is added from the same
// NEXT_PUBLIC_API_URL the client reads (lib/api.ts). Nothing for a relative URL.
const configuredApiOrigin = (() => {
  try {
    const raw = (process.env.NEXT_PUBLIC_API_URL || '').trim();
    return /^https?:\/\//.test(raw) ? new URL(raw).origin : null;
  } catch {
    return null;
  }
})();

const connectSrc = [
  "connect-src 'self'",
  ...(configuredApiOrigin ? [configuredApiOrigin] : []),
  ...(isProd ? [] : ["http://localhost:8080", "http://127.0.0.1:8080"]),
  "http://127.0.0.1:41338",
  // The hosted API. Hosted builds call only this origin (the client's
  // NEXT_PUBLIC_API_URL); any other API origin a build is pointed at is added
  // above from that same variable.
  "https://api.deerdawn.com",
  "https://*.clerk.com",
  "https://*.clerk.dev",
  "https://*.clerk.accounts.dev",
  "https://clerk.deerdawn.com",
  "https://clerk.app.deerdawn.com",
  "https://challenges.cloudflare.com",
  // Google Ads + GA4 measurement / conversion endpoints (gtag beacons).
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
  // Both forms are required. A CSP wildcard matches only hosts that HAVE a
  // subdomain label, so *.analytics.google.com covers the regional endpoints
  // (region1.analytics.google.com) but NOT the bare apex — and gtag.js sends
  // /g/collect to the apex, so every GA4 beacon was refused outright.
  "https://analytics.google.com",
  "https://*.analytics.google.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
  // FE-03: pin exact Ads beacon hosts instead of *.doubleclick.net / *.google.com wildcards.
  "https://ad.doubleclick.net",
  "https://stats.g.doubleclick.net",
  "https://www.google.com",
  // PostHog ingestion (us.i.posthog.com /e/ event capture + us-assets.i.posthog.com).
  "https://*.posthog.com",
  // Reddit Pixel event beacons (pixel.js posts to alb.reddit.com / *.reddit.com).
  "https://*.reddit.com",
  // M18: script-src already allowlists static.cloudflareinsights.com (below) and
  // this app ships @vercel/analytics + @vercel/speed-insights, but connect-src
  // was missing all of their beacon hosts — those scripts loaded fine but every
  // beacon they tried to send was silently blocked by CSP.
  "https://static.cloudflareinsights.com",
  "https://va.vercel-scripts.com",
  "https://*.vercel-insights.com",
  "https://vitals.vercel-insights.com",
  // Sentry ingest. The DSN host is o<org>.ingest.us.sentry.io, and replay
  // uploads go to the same origin — without this every event is refused by CSP
  // and the SDK surfaces nothing, so it reads as "Sentry just isn't working".
  // Both forms: US region DSNs carry the .us. label, older/EU ones do not.
  "https://*.ingest.us.sentry.io",
  "https://*.ingest.sentry.io",
].join(" ");

const frameSrc = [
  "frame-src 'self'",
  "https://*.clerk.com",
  "https://*.clerk.dev",
  "https://*.clerk.accounts.dev",
  "https://clerk.deerdawn.com",
  "https://clerk.app.deerdawn.com",
  "https://challenges.cloudflare.com",
].join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  connectSrc,
  frameSrc,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// Container builds (apps/dashboard/Dockerfile, self-hosting) set
// NEXT_OUTPUT=standalone so the image ships only the traced server files rather
// than the whole workspace node_modules. Vercel builds leave it unset and are
// unaffected. The tracing root is the monorepo root, matching turbopack.root.
const standaloneOutput = process.env.NEXT_OUTPUT === 'standalone';

const nextConfig: NextConfig = {
  ...(standaloneOutput
    ? { output: 'standalone' as const, outputFileTracingRoot: path.join(process.cwd(), '../..') }
    : {}),
  // Self-hosted / telemetry switches, inlined at build time from the SAME names
  // the API reads (SELF_HOSTED, TELEMETRY_ENABLED). lib/telemetryGate.ts reads
  // them to decide whether any analytics may load at all.
  env: {
    DD_SELF_HOSTED: process.env.SELF_HOSTED || '',
    DD_TELEMETRY_ENABLED: process.env.TELEMETRY_ENABLED || '',
    // Vercel sets VERCEL=1 in its builds; Vercel Analytics loads only there.
    DD_ON_VERCEL: process.env.VERCEL || '',
  },
  /* config options here */
  // Lets a second local dev server run against the same checkout (Next locks .next per instance).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  compress: true,
  poweredByHeader: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  experimental: {
    optimizePackageImports: ['@clerk/nextjs'],
  },
  turbopack: {
    root: path.join(process.cwd(), '../..'),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
          },
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy,
          },
        ],
      },
    ];
  },
  async redirects() {
    const commonRedirects = [
      // Clerk's invitation/OAuth flow uses hyphenated paths by default;
      // redirect to the actual pages so query params (ticket, status) are preserved.
      {
        source: "/sign-up",
        destination: "/signup",
        permanent: false,
      },
      {
        source: "/sign-in",
        destination: "/login",
        permanent: false,
      },
      {
        source: "/hello-world",
        destination: "/",
        permanent: true,
      },
      // Redesign: four destinations named by job. The old URLs are published in
      // marketing copy, agent-discovery markdown and users' bookmarks, so they
      // keep working rather than 404ing.
      {
        source: "/context/context-graph",
        destination: "/memory",
        permanent: false,
      },
      {
        source: "/settings/tools",
        destination: "/setup",
        permanent: false,
      },
      {
        source: "/api-keys",
        destination: "/setup#keys",
        permanent: false,
      },
      {
        source: "/:path(hello-world|blog|posts)/:slug*",
        destination: "/",
        permanent: true,
      },
    ];

    if (brandMode !== 'governance' && isProd) {
      return [
        ...commonRedirects,
        // Keep context-sync workspace setup on app.deerdawn.com.
        // Only governance-specific surfaces should cross over to the governance app.
        {
          source: "/:path(policies|decisions|escalations|playground|usage|audit)",
          destination: `${governanceAppUrl}/:path`,
          permanent: false,
        },
        {
          source: "/governance/:path*",
          destination: `${governanceAppUrl}/governance/:path*`,
          permanent: false,
        },
        {
          source: "/settings/governance/:path*",
          destination: `${governanceAppUrl}/settings/:path*`,
          permanent: false,
        },
        // NOTE: there is deliberately no /admin/:path* rule here.
        //
        // There used to be one, sending every /admin/* path to the governance
        // app. It dated from before governance was extracted into its own
        // repo, when /admin WAS the governance console. After the extraction
        // this repo's /admin pages became session-memory OPERATOR surfaces
        // (content, retention, today), and the rule kept forwarding them away.
        //
        // WHERE IT FORWARDED THEM IS THE WHOLE POINT, and it is not what it
        // looks like. `app.governance.deerdawn.com` is not a separate app — it
        // is an ALIAS on this very Vercel deployment, alongside
        // app.deerdawn.com (confirm with the deployment's `alias` array). So
        // the redirect handed the request back to the identical Next.js app
        // under a different hostname, which evaluated this identical rule
        // again, and again:
        //
        //   app.deerdawn.com/admin/today
        //     -> 307 app.governance.deerdawn.com/admin/today
        //     -> 307 the same URL, forever   (curl gave up at 10 hops)
        //
        // Self-referential, therefore unterminating by construction — it could
        // never have worked at any point after the extraction, and no amount of
        // fixing the governance app would have helped. It also failed
        // invisibly: a redirect throws nothing and 404s nothing, so
        // /admin/retention was shipped, linked and dead for months with every
        // check green.
        //
        // If that alias is ever removed from this project, this note stops
        // being true about the mechanism — the loop becomes a plain
        // cross-host redirect. The rule stays gone either way.
        //
        // Adding a rule back would silently swallow the next operator page the
        // same way, so admin-routes-contract pins its absence.
      ];
    }

    return commonRedirects;
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Upload source maps so production stack traces name real files and lines
  // instead of chunk offsets. Needs SENTRY_AUTH_TOKEN in the build env; without
  // it the plugin skips the upload rather than failing the build.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Strip the uploaded maps from the client bundle after upload — Sentry can
  // still symbolicate, but the maps are not served to visitors.
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  // NO disableLogger / reactComponentAnnotation here, deliberately. Both are
  // webpack-only and this app builds with Turbopack (Next 16 default), so the
  // SDK prints "DEPRECATION WARNING ... (Not supported with Turbopack.)" and
  // then ignores them. They were set here and did nothing — including the
  // debug-log stripping the old comment claimed. Turbopack has no equivalent
  // yet; when it does, that is the moment to add it back.
});
