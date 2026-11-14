/**
 * May this browser load product analytics (PostHog, gtag, Reddit pixel, Vercel
 * Analytics / Speed Insights)?
 *
 * Decided at BUILD time, from `DD_SELF_HOSTED` / `DD_TELEMETRY_ENABLED`, which
 * next.config.ts inlines from the same SELF_HOSTED / TELEMETRY_ENABLED variables
 * the API reads. It has to be: analytics load before any request to the API
 * could answer, and a tag that fires while we wait has already sent its beacon.
 *
 *   Hosted build (SELF_HOSTED unset): allowed; each tool is still gated on its
 *     own key exactly as before.
 *   Self-hosted build: off unless TELEMETRY_ENABLED=true.
 *
 * Kept free of imports so the analytics modules can read it without pulling the
 * API client into their chunk.
 */
function flag(value: string | undefined): boolean {
  return String(value || '').trim().toLowerCase() === 'true';
}

/**
 * Built as a self-hosted dashboard (SELF_HOSTED=true at build time). On the
 * SERVER (the _document render, the same-origin tag routes) the runtime
 * SELF_HOSTED is honoured as well, so an image built without the flag but
 * started with it still serves no tags.
 */
export function isSelfHostedBuild(): boolean {
  if (flag(process.env.DD_SELF_HOSTED)) return true;
  return typeof window === 'undefined' && flag(process.env.SELF_HOSTED);
}

export function clientTelemetryAllowed(): boolean {
  if (!isSelfHostedBuild()) return true;
  return flag(process.env.DD_TELEMETRY_ENABLED)
    || (typeof window === 'undefined' && flag(process.env.TELEMETRY_ENABLED));
}

/**
 * Vercel Analytics / Speed Insights: only on a Vercel deployment (their
 * scripts are served by Vercel's edge; anywhere else they 404 or beacon to
 * nothing) and only where telemetry is allowed.
 */
export function vercelInsightsAllowed(): boolean {
  return clientTelemetryAllowed() && flag(process.env.DD_ON_VERCEL ? 'true' : '');
}
