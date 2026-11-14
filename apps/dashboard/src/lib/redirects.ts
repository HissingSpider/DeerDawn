const ALLOWED_REDIRECT_DOMAINS = ['stripe.com', 'deerdawn.com'];
const LOCAL_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

export function isSafeExternalRedirectUrl(url: string): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const parsed = new URL(url, window.location.origin);
    const isLocalHost = LOCAL_REDIRECT_HOSTS.has(parsed.hostname);
    const isAllowedDomain = ALLOWED_REDIRECT_DOMAINS.some((domain) => (
      parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    ));

    if (!isLocalHost && parsed.protocol !== 'https:') {
      return false;
    }

    return (
      parsed.origin === window.location.origin ||
      isLocalHost ||
      isAllowedDomain
    );
  } catch {
    return false;
  }
}

export function redirectToTrustedUrl(url: string) {
  if (!isSafeExternalRedirectUrl(url)) {
    throw new Error('Unsafe redirect URL');
  }

  window.location.assign(url);
}

// H10: guard for post-auth navigation (login/signup redirect_url). Unlike
// isSafeExternalRedirectUrl (which allows a small allowlist of trusted external
// domains for things like Stripe), this is intentionally stricter: the only
// acceptable shape is a same-origin relative path starting with a single '/'.
// Anything else — protocol-relative ('//evil.tld'), backslash tricks
// ('/\\evil.tld', which browsers/URL parsers can normalize into a host change),
// absolute URLs, or non-http(s) schemes ('javascript:...') — falls back to '/'.
//
// Implementation resolves the candidate against a fixed, unresolvable base and
// checks the resulting origin didn't change. This works in both browser and
// Node (no `window` dependency), so it can run at the point of consumption
// (SSR-safe) as well as in unit tests.
const REDIRECT_PATH_BASE = 'http://internal.invalid';

export function getSafeRedirectPath(url?: string | null, fallback = '/'): string {
  if (typeof url !== 'string' || url.length === 0) return fallback;
  if (!url.startsWith('/') || url.startsWith('//')) return fallback;

  try {
    const resolved = new URL(url, REDIRECT_PATH_BASE);
    if (resolved.origin !== REDIRECT_PATH_BASE) return fallback;
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // Re-check the RESOLVED path, not just the input. URL normalization collapses
    // traversal, so '/..//evil.tld' passes the input check above and then resolves to
    // pathname '//evil.tld' — protocol-relative, which a browser reads as
    // https://evil.tld. Validating only the input reintroduced the exact open redirect
    // this function exists to close.
    if (!path.startsWith('/') || path.startsWith('//')) return fallback;
    return path;
  } catch {
    return fallback;
  }
}

/**
 * Where to send someone after sign-in or sign-up, from the query Clerk builds.
 *
 * Clerk's <SignInButton>/<SignUpButton> in redirect mode send the visitor to
 * /login or /signup with `sign_in_force_redirect_url` / `sign_up_force_redirect_url`
 * and `redirect_url`, and every one of them is an ABSOLUTE URL. The pages read
 * only `redirect_url` and getSafeRedirectPath rejects anything absolute, so the
 * authorize screens' "sign in and we'll bring you back" returned people to "/"
 * instead, without the ?code= / ?req= their connection needed.
 *
 * A same-origin absolute URL is reduced to its path; anything else is dropped.
 * `origin` is passed in so this stays pure and testable; on the server it is
 * unknown and the result is undefined until the client renders.
 */
export function resolveAuthReturnPath(
  query: Record<string, string | string[] | undefined>,
  origin: string | null | undefined,
  mode: 'login' | 'signup',
): string | undefined {
  const pick = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined);
  const candidates = mode === 'signup'
    ? [pick('sign_up_force_redirect_url'), pick('redirect_url')]
    : [pick('sign_in_force_redirect_url'), pick('redirect_url')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.startsWith('/') && !candidate.startsWith('//')) {
      const safe = getSafeRedirectPath(candidate, '');
      if (safe) return safe;
      continue;
    }
    if (!origin) continue;
    try {
      const url = new URL(candidate);
      if (url.origin !== origin) continue;
      const safe = getSafeRedirectPath(`${url.pathname}${url.search}${url.hash}`, '');
      if (safe) return safe;
    } catch {
      // not a URL; try the next candidate
    }
  }
  return undefined;
}

/**
 * Clerk's redirect to a custom sign-in/sign-up URL carries its return
 * parameters in the HASH, as `#/?redirect_url=...&sign_in_force_redirect_url=...`,
 * where Next's router.query never sees them. Read both and let the query win.
 */
export function authQueryWithClerkHash(
  query: Record<string, string | string[] | undefined>,
  hash: string | null | undefined,
): Record<string, string | string[] | undefined> {
  const raw = String(hash || '').replace(/^#\/?\??/, '');
  if (!raw) return query;
  const fromHash: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) fromHash[key] = value;
  return { ...fromHash, ...query };
}
