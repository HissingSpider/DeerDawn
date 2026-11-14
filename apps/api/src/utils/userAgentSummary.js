/**
 * The few browser/OS fields PostHog's JS SDK would have stamped, derived from a
 * raw User-Agent for events relayed through posthog-node (which stamps none).
 *
 * Deliberately small: it names the common engines well enough to slice a funnel
 * and returns nothing rather than guessing for anything else. It is not a bot
 * detector; crawler exclusion keys on `$raw_user_agent`.
 */

// Order matters: Edge and Opera carry "Chrome", Chrome carries "Safari".
const BROWSERS = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /\b(?:OPR|Opera)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+).*\bSafari\//],
];

const OPERATING_SYSTEMS = [
  ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
  ['Android', /\bAndroid\b/],
  ['Windows', /\bWindows NT\b/],
  ['Mac OS X', /\bMac OS X\b/],
  ['Chrome OS', /\bCrOS\b/],
  ['Linux', /\bLinux\b/],
];

function summarizeUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return {};
  const out = {};
  for (const [name, pattern] of BROWSERS) {
    const match = userAgent.match(pattern);
    if (match) {
      out.$browser = name;
      out.$browser_version = Number(match[1]);
      break;
    }
  }
  for (const [name, pattern] of OPERATING_SYSTEMS) {
    if (pattern.test(userAgent)) {
      out.$os = name;
      break;
    }
  }
  return out;
}

/**
 * origin + pathname only. A dashboard URL can carry an OAuth `?code=`, a
 * `?req=` or a stash token in its query, none of which belongs in analytics.
 */
function sanitizeCurrentUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { $current_url: `${url.origin}${url.pathname}`, $host: url.host, $pathname: url.pathname };
  } catch {
    return null;
  }
}

module.exports = { summarizeUserAgent, sanitizeCurrentUrl };
