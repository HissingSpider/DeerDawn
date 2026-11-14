/**
 * Is this browser automation rather than a person?
 *
 * MIRROR of `isSyntheticAgent()` in apps/marketing/src/lib/posthog.ts, which has
 * kept synthetic loads out of the visitor funnel since 2026-08-12. The dashboard
 * never got the same gate, and the dashboard is where the entire activation
 * funnel lives — onboarding, mcp_setup_viewed, mcp_config_copied, both authorize
 * screens, oauth_consent_viewed/approved. So every measurement on the step the
 * standing priority is aimed at has been counting our own nightly journey E2E.
 *
 * Measured 2026-08-29, 30 days, `coalesce(person.properties.is_test, false) =
 * false`: of the 11 people who reached `oauth_consent_viewed`, six carry exactly
 * one event and no properties at all, and four of those six land inside the
 * nightly journey window on desktop. Every one of the six has `signed_in = 0`.
 *
 * That last part is the structural half, and it is why `is_test` cannot fix
 * this: `is_test` is a PERSON property, set when an account identifies. A
 * signed-out arrival never identifies, so it never gets the flag, so it is
 * invisible to the validity gate by construction. The journey bot's signed-IN
 * leg is correctly filtered out every night; its signed-OUT leg is not, and the
 * signed-out authorize screen is exactly the surface E-011 is measuring.
 *
 * `navigator.webdriver` is the load-bearing check, not the user agent. Verified
 * empirically against this repo's own Playwright config on 2026-08-29:
 * `devices['Desktop Chrome']` reports
 *   navigator.webdriver === true
 *   UA "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/148 ... Safari/537.36"
 * — an ordinary Windows Chrome string with no automation token in it. UA
 * sniffing cannot see our own bot. The UA pattern below is kept only as a
 * backstop for tooling that does self-identify, and every token in it is one no
 * shipping browser sends.
 */
// `meta-externalagent` added 2026-09-15 (E-023). Meta's crawler renders pages
// with JavaScript, and from 2026-09-10 it has been loading /oauth/consent URLs
// that third-party OAuth demo pages publish — 4 visits in 4 days, each one a
// signed-out consent view plus `oauth_consent_signin_shown`, and each one a new
// property-less PostHog person, because it sends no `navigator.webdriver` and so
// never got `is_automation`. That is the denominator E-011 is read on.
const SYNTHETIC_UA_PATTERN = /HeadlessChrome|Chrome-Lighthouse|Google-AdWords-Express|Google-Websight|meta-externalagent/;

// Headless Chrome's default SCREEN size (E-039), mirroring the marketing gate.
// A crawler that spoofs a normal desktop UA and sends no webdriver flag still
// reports 800x600 unless told otherwise. 120 such desktop "visitors" in the 60
// days to 2026-10-04, all single pageviews from datacenter cities, none of them
// ever opened the signup modal or created an account. Three reached this app
// (/login, /oauth/consent). Screen, not viewport, and both values must match.
const HEADLESS_DEFAULT_SCREEN = { width: 800, height: 600 };

function hasHeadlessDefaultScreen(): boolean {
  try {
    const s = (window as { screen?: { width?: number; height?: number } }).screen;
    return !!s && s.width === HEADLESS_DEFAULT_SCREEN.width && s.height === HEADLESS_DEFAULT_SCREEN.height;
  } catch {
    return false;
  }
}

export function isSyntheticAgent(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (navigator.webdriver === true) return true;
  if (SYNTHETIC_UA_PATTERN.test(navigator.userAgent || '')) return true;
  return hasHeadlessDefaultScreen();
}
