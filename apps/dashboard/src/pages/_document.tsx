import { Html, Head, Main, NextScript } from "next/document";
import { siteConfig } from '@/lib/siteConfig';
import { GOOGLE_ADS_ID, GA4_ID } from '@/lib/gtag';
import { clientTelemetryAllowed } from '@/lib/telemetryGate';

const description = 'AI session memory for professionals moving between AI tools — the brief every new session reads first.';
const title = 'DeerDawn App';

export default function Document() {
  // Google Ads (AW-) and GA4 (G-) share one gtag.js loader; emit a config line
  // per id that is set. The loader can be requested with either id. Ids come
  // from src/lib/gtag.ts (Ads id has a baked-in default; GA4 is env-gated),
  // so the loader and the conversion helpers always agree.
  // A self-hosted build loads no ad or analytics tag unless TELEMETRY_ENABLED=true
  // (lib/telemetryGate.ts). The Ads id has a baked-in default, so without this a
  // self-host would beacon to DeerDawn's own Google Ads account.
  const telemetry = clientTelemetryAllowed();
  const tagIds = telemetry ? [GOOGLE_ADS_ID, GA4_ID].filter(Boolean) : [];
  const redditPixelId = telemetry ? process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID : undefined;
  return (
    <Html lang="en">
      <Head>
        <meta name="robots" content="noindex,nofollow" />
        {tagIds.length > 0 ? (
          <>
            {/* gtag.js loader + per-id config for Google Ads / GA4. Purchase +
                first_sync conversions and GA4 pageviews fire via src/lib/gtag.ts.
                Loaded by SOURCE (googletagmanager.com / 'self'), never inline: the
                dashboard ships a strict CSP (script-src 'self', no nonce), so an
                inline bootstrap is blocked. The config lives in the same-origin
                /gtag-init.js route, which 'self' permits. */}
            <script async src={`https://www.googletagmanager.com/gtag/js?id=${tagIds[0]}`} />
            {/* Must load synchronously by source so window.dataLayer/gtag exist
                before page scripts fire; served same-origin so 'self' allows it. */}
            {/* eslint-disable-next-line @next/next/no-sync-scripts */}
            <script src="/gtag-init.js" />
          </>
        ) : null}
        {redditPixelId ? (
          <>
            {/* Reddit Pixel bootstrap (loader + init + PageVisit). Served
                same-origin from /rdt-init.js for the same CSP reason as
                /gtag-init.js; the SignUp conversion fires via src/lib/reddit.ts. */}
            <link rel="preconnect" href="https://www.redditstatic.com" />
            {/* eslint-disable-next-line @next/next/no-sync-scripts */}
            <script src="/rdt-init.js" />
          </>
        ) : null}
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#10B981" />
        <meta name="msapplication-TileColor" content="#07111d" />
        {/* Default (dark) browser-chrome color; theme-init.js rewrites this
            pre-paint to match the resolved light/dark theme. */}
        <meta name="theme-color" content="#07111d" />
        {/* Flash-free theme bootstrap. Must run synchronously in <head> before
            first paint. Served same-origin (not inline) because the strict CSP
            (script-src 'self', no nonce) blocks inline scripts. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" href="/favicon.png" />

        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${siteConfig.ACTIVE_APP_URL}/`} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={`${siteConfig.ACTIVE_APP_URL}/og-image.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="DeerDawn logo on a dark background" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content={`${siteConfig.ACTIVE_APP_URL}/`} />
        <meta property="twitter:title" content={title} />
        <meta property="twitter:description" content={description} />
        <meta property="twitter:image" content={`${siteConfig.ACTIVE_APP_URL}/og-image.png`} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
