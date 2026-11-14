import type { GetServerSideProps } from 'next';

/**
 * Serves the Reddit Pixel bootstrap (loader + init + PageVisit) as a SAME-ORIGIN
 * script at /rdt-init.js.
 *
 * Same rationale as /gtag-init.js: the dashboard ships a strict CSP
 * (script-src 'self', no nonce), so an inline <script> is blocked. An external
 * script from 'self' is allowed, so the pixel bootstrap runs reliably. The
 * pixel.js it injects loads from redditstatic.com, allowlisted in script-src
 * (next.config.ts). Gated on NEXT_PUBLIC_REDDIT_PIXEL_ID — emits an inert script
 * until the id is set. Read at request time; identical per build, so cacheable.
 */
function buildRdtInit(): string {
  const pixelId = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID || '';
  if (!pixelId) return '/* no reddit pixel id configured */';
  // Standard Reddit Pixel bootstrap: defines window.rdt with a call queue,
  // injects redditstatic.com/ads/pixel.js, then init + a PageVisit. Because
  // deerdawn.com and app.deerdawn.com share the registrable domain, the
  // _rdt_uuid cookie set on the marketing landing carries here for the SignUp.
  return (
    `!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js";t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);` +
    `rdt('init',${JSON.stringify(pixelId)});` +
    `rdt('track','PageVisit');`
  );
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  res.write(buildRdtInit());
  res.end();
  return { props: {} };
};

export default function RdtInit() {
  return null;
}
