/**
 * First-touch attribution capture for the dashboard.
 *
 * Google Ads traffic lands on the marketing site, which forwards
 * utm_source/medium/campaign/term/content + campaign into the signup URL. Those
 * params then ride through Clerk -> select-plan -> checkout. We stash them in
 * localStorage on first sight (first-touch) so later events — first_sync and
 * purchase, which fire after a Stripe round-trip that drops the query string —
 * can still be attributed to the originating keyword/campaign.
 *
 * trackProductEvent() (productAnalytics.ts) auto-attaches getAttribution() to
 * every event's metadata, so call captureAttribution() early (in _app) and the
 * rest is automatic.
 */

const ATTRIBUTION_KEY = 'dd_attribution_v1';

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export type Attribution = Partial<Record<(typeof UTM_KEYS)[number], string>> & {
  campaign?: string;
  landing_page?: string;
  // Reddit ad click id, forwarded from the landing URL (?rdt_cid=…). Threaded
  // through Clerk unsafeMetadata so the account_created webhook can fire the
  // server-side Reddit Conversions API with the strongest match signal.
  rdt_cid?: string;
};

type Query = Record<string, string | string[] | undefined>;

function pick(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

export function getAttribution(): Attribution {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(ATTRIBUTION_KEY) || '{}') as Attribution;
  } catch {
    return {};
  }
}

/**
 * Merge any attribution params present in `query` into the stored first-touch
 * record. Existing values are never overwritten, so the original campaign wins
 * even as the user navigates deeper.
 */
export function captureAttribution(query: Query): void {
  if (typeof window === 'undefined') return;

  const current = getAttribution();
  const next: Attribution = { ...current };
  let changed = false;

  for (const key of UTM_KEYS) {
    const value = pick(query[key]);
    if (value && !next[key]) {
      next[key] = value;
      changed = true;
    }
  }

  const campaign = pick(query.campaign);
  if (campaign && !next.campaign) {
    next.campaign = campaign;
    changed = true;
  }

  const rdtCid = pick(query.rdt_cid);
  if (rdtCid && !next.rdt_cid) {
    next.rdt_cid = rdtCid;
    changed = true;
  }

  // Record the first page that carried attribution so we know the entry point.
  if ((changed || !next.landing_page) && hasAnyAttribution(next)) {
    if (!next.landing_page) {
      next.landing_page = window.location.pathname;
      changed = true;
    }
  }

  if (changed) {
    try {
      window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (private mode / quota) — attribution is best-effort.
    }
  }
}

/**
 * Google (and Reddit) ad click ids for the SIGN-UP only, read from the
 * first-party `dd_click_v1` cookie the marketing site sets on .deerdawn.com
 * (apps/marketing/src/lib/attribution.ts, buildClickIdCookie).
 *
 * WHY: the paid CLI path — deerdawn.com/start?gclid=… → `npx … setup` → the CLI
 * opens app.deerdawn.com/mcp-auth → sign up — crosses origins, and this
 * origin's localStorage never saw the gclid. Without it the account_created
 * webhook stored no click id and the Google Ads SETUP conversion (fired on
 * first_sync_completed) had nothing to key on.
 *
 * Deliberately NOT merged into getAttribution(): that record rides on every
 * product event, and a click id belongs on the signup alone. The current URL is
 * the fallback for an ad pointed straight at the app.
 */
export const CLICK_ID_COOKIE = 'dd_click_v1';
const CLICK_ID_KEYS = ['gclid', 'wbraid', 'gbraid', 'rdt_cid'] as const;
export type ClickIds = Partial<Record<(typeof CLICK_ID_KEYS)[number], string>>;

const CLICK_ID_SHAPE = /^[A-Za-z0-9_.-]{1,256}$/;

export function parseClickIdCookie(cookieHeader: string): ClickIds {
  const raw = cookieHeader
    .split(/;\s*/)
    .find((c) => c.startsWith(`${CLICK_ID_COOKIE}=`));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw.slice(CLICK_ID_COOKIE.length + 1)));
    const out: ClickIds = {};
    for (const key of CLICK_ID_KEYS) {
      const v = parsed && typeof parsed === 'object' ? parsed[key] : undefined;
      if (typeof v === 'string' && CLICK_ID_SHAPE.test(v)) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function getClickIds(): ClickIds {
  if (typeof window === 'undefined') return {};
  let fromCookie: ClickIds = {};
  try {
    fromCookie = parseClickIdCookie(document.cookie || '');
  } catch {
    fromCookie = {};
  }
  const out: ClickIds = { ...fromCookie };
  try {
    const params = new URLSearchParams(window.location.search);
    for (const key of CLICK_ID_KEYS) {
      const v = params.get(key);
      if (!out[key] && v && CLICK_ID_SHAPE.test(v)) out[key] = v;
    }
  } catch {
    // No usable URL — the cookie is all there is.
  }
  return out;
}

function hasAnyAttribution(a: Attribution): boolean {
  return Boolean(a.utm_source || a.utm_campaign || a.utm_term || a.utm_content || a.campaign);
}
