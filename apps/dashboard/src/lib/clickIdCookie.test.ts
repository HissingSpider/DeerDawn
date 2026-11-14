/**
 * The Google click id has to survive deerdawn.com -> CLI -> app.deerdawn.com.
 *
 * The paid path is deerdawn.com/start?gclid=... -> copy `npx ... setup` -> the
 * CLI opens app.deerdawn.com/mcp-auth -> sign up there. The app origin cannot
 * read the marketing origin's localStorage and the CLI's URL carries no gclid,
 * so the sign-up reached the Clerk webhook with no click id, and the Google Ads
 * SETUP conversion (first_sync_completed) had nothing to key on.
 *
 * The hand-off is a first-party cookie on .deerdawn.com written by marketing
 * (buildClickIdCookie) and read here (parseClickIdCookie). This pins the two
 * halves against each other: the name, the encoding and the domain.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseClickIdCookie, CLICK_ID_COOKIE as DASHBOARD_COOKIE } from './attribution';

// The marketing half lives in apps/marketing, which only the private repo has
// (the public export does not ship it). Loaded by a computed path so the
// dashboard still type-checks without it; every test that needs it skips when
// it is absent.
const MARKETING_ATTRIBUTION = fileURLToPath(new URL('../../../marketing/src/lib/attribution.ts', import.meta.url));
const skip = existsSync(MARKETING_ATTRIBUTION)
  ? false
  : 'apps/marketing is not in this checkout (private repo only)';

type MarketingAttribution = {
  buildClickIdCookie: (ids: Record<string, string>, host: string, secure: boolean) => string | null;
  cookieDomainFor: (host: string) => string | null;
  CLICK_ID_COOKIE: string;
};
let marketing: Promise<MarketingAttribution> | null = null;
const loadMarketing = () => (marketing ||= import(pathToFileURL(MARKETING_ATTRIBUTION).href) as Promise<MarketingAttribution>);

// What document.cookie returns: name=value pairs only, attributes stripped.
const asDocumentCookie = (setCookie: string) => setCookie.split('; ')[0];

test('both apps name the same cookie', { skip }, async () => {
  const { CLICK_ID_COOKIE: MARKETING_COOKIE } = await loadMarketing();
  assert.strictEqual(MARKETING_COOKIE, DASHBOARD_COOKIE);
});

test('marketing writes it on .deerdawn.com so app.deerdawn.com can read it', { skip }, async () => {
  const { buildClickIdCookie, cookieDomainFor } = await loadMarketing();
  assert.strictEqual(cookieDomainFor('deerdawn.com'), '.deerdawn.com');
  assert.strictEqual(cookieDomainFor('www.deerdawn.com'), '.deerdawn.com');
  assert.strictEqual(cookieDomainFor('localhost'), null);
  assert.strictEqual(cookieDomainFor('evil-deerdawn.com'), null);
  const c = buildClickIdCookie({ gclid: 'Cj0KCQ-abc_123' }, 'deerdawn.com', true)!;
  assert.match(c, /; Domain=\.deerdawn\.com/);
  assert.match(c, /; Secure/);
  assert.match(c, /; SameSite=Lax/);
  assert.match(c, /; Max-Age=7776000/); // 90 days, Google's longest click window
});

test('round trip: what marketing writes, the dashboard reads', { skip }, async () => {
  const { buildClickIdCookie } = await loadMarketing();
  const c = buildClickIdCookie({ gclid: 'Cj0KCQ-abc_123', rdt_cid: 'r.1', utm_source: 'google' }, 'deerdawn.com', true)!;
  const read = parseClickIdCookie(`other=1; ${asDocumentCookie(c)}; ph_x=2`);
  assert.deepStrictEqual(read, { gclid: 'Cj0KCQ-abc_123', rdt_cid: 'r.1' });
});

test('no click id, no cookie', { skip }, async () => {
  const { buildClickIdCookie } = await loadMarketing();
  assert.strictEqual(buildClickIdCookie({ utm_source: 'google' }, 'deerdawn.com', true), null);
});

test('junk is dropped on the dashboard side', () => {
  const forged = `${DASHBOARD_COOKIE}=${encodeURIComponent(JSON.stringify({ gclid: 'a b', wbraid: 'ok' }))}`;
  assert.deepStrictEqual(parseClickIdCookie(forged), { wbraid: 'ok' });
  assert.deepStrictEqual(parseClickIdCookie(`${DASHBOARD_COOKIE}=%7Bnot-json`), {});
  assert.deepStrictEqual(parseClickIdCookie(''), {});
});

test('junk is dropped on the marketing side', { skip }, async () => {
  const { buildClickIdCookie } = await loadMarketing();
  assert.strictEqual(buildClickIdCookie({ gclid: '<script>' }, 'deerdawn.com', true), null);
});
