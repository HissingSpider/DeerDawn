import type { GetServerSideProps } from 'next';
import { GOOGLE_ADS_ID, GA4_ID } from '@/lib/gtag';
import { clientTelemetryAllowed } from '@/lib/telemetryGate';

/**
 * Serves the gtag.js bootstrap (dataLayer + per-id config) as a SAME-ORIGIN
 * script at /gtag-init.js.
 *
 * Why an external file instead of an inline <script>: the dashboard ships a
 * strict CSP (script-src 'self', no nonce, no 'unsafe-inline'), so an inline
 * bootstrap in _document is blocked by the browser. An external script from
 * 'self' is allowed with no nonce, so the Google Ads / GA4 config reliably runs
 * — which is what lets purchase / first_sync conversions actually fire from the
 * authed app. Ids are read from env at request time; output is identical per
 * build, so it is cacheable.
 */
function buildGtagInit(): string {
  // Ids come from src/lib/gtag.ts (Ads id has a baked-in default; GA4 is
  // env-gated) so this bootstrap always matches the loader in _document.tsx.
  // Self-hosted builds: no tag unless TELEMETRY_ENABLED=true (lib/telemetryGate).
  const ids = clientTelemetryAllowed() ? [GOOGLE_ADS_ID, GA4_ID].filter(Boolean) : [];
  if (ids.length === 0) return '/* no analytics ids configured */';
  return (
    `window.dataLayer=window.dataLayer||[];` +
    `function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());` +
    // Cross-host linking (plan B8) — the receiving half. The ad click landed
    // on deerdawn.com; the purchase / first_sync conversions fire HERE. When
    // the _gcl_* cookies didn't survive the trip (Safari ITP, an OAuth
    // round-trip re-entering on this host), the marketing side decorates the
    // link with _gl and accept_incoming is what reads it back into cookies on
    // this host. Must be SET before the per-id config lines. Mirrors
    // apps/marketing/src/pages/gtag-init.js.ts — keep the two in step.
    `gtag('set','linker',{domains:['deerdawn.com'],accept_incoming:true});` +
    ids.map((id) => `gtag('config','${id}');`).join('')
  );
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  res.write(buildGtagInit());
  res.end();
  return { props: {} };
};

export default function GtagInit() {
  return null;
}
