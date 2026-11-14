import test from 'node:test';
import assert from 'node:assert/strict';

import { isSyntheticAgent } from './syntheticAgent';

// The dashboard runs the entire activation funnel — onboarding, config copy,
// both authorize screens — and until 2026-08-29 had no automation gate at all,
// while marketing has had one since 2026-08-12. These pin the two halves of the
// check that matter, in the direction each one actually failed.

type NavStub = { webdriver?: boolean; userAgent?: string };

function withNavigator<T>(nav: NavStub | null, fn: () => T): T {
  const g = globalThis as unknown as { window?: unknown; navigator?: unknown };
  const hadWindow = 'window' in g;
  const prevWindow = g.window;
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (nav === null) {
    delete g.window;
  } else {
    g.window = {};
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  }
  try {
    return fn();
  } finally {
    if (hadWindow) g.window = prevWindow; else delete g.window;
    if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
    else delete (globalThis as unknown as { navigator?: unknown }).navigator;
  }
}

test('navigator.webdriver is the load-bearing check', () => {
  // This repo's own Playwright config uses devices['Desktop Chrome'], which
  // sends an ordinary Windows Chrome user agent with no automation token in it
  // (verified against the installed Playwright on 2026-08-29). The UA pattern
  // cannot see our nightly journey run; the webdriver flag can, and it is the
  // only reason this gate works at all.
  const realChromeUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36';

  assert.equal(
    withNavigator({ webdriver: true, userAgent: realChromeUA }, isSyntheticAgent),
    true,
    'a driven browser sending a normal UA must still be caught'
  );
  assert.equal(
    withNavigator({ webdriver: false, userAgent: realChromeUA }, isSyntheticAgent),
    false,
    'the same UA without a driver is a real person and must pass'
  );
});

test('self-identifying automation is caught by user agent as a backstop', () => {
  for (const ua of ['HeadlessChrome/148.0', 'Chrome-Lighthouse', 'Google-AdWords-Express']) {
    assert.equal(
      withNavigator({ webdriver: false, userAgent: ua }, isSyntheticAgent),
      true,
      `${ua} names itself and no shipping browser sends it`
    );
  }
});

test('ordinary browsers are never treated as synthetic', () => {
  const humans = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  ];
  for (const userAgent of humans) {
    assert.equal(withNavigator({ webdriver: false, userAgent }, isSyntheticAgent), false, userAgent);
  }
});

test('server-side rendering is not synthetic', () => {
  // Called during SSR there is no window and no navigator; returning true there
  // would suppress analytics for every real user on first render.
  assert.equal(withNavigator(null, isSyntheticAgent), false);
});

test('the Meta crawler that renders consent pages is caught (E-023)', () => {
  // Observed on /oauth/consent 2026-09-10..09-13: four visits, four signed-out
  // consent views, four new property-less PostHog persons. No webdriver flag, so
  // the user agent is the only signal — and it names itself.
  const metaCrawler =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))';
  assert.equal(withNavigator({ webdriver: false, userAgent: metaCrawler }, isSyntheticAgent), true);

  // Facebook's and Instagram's in-app browsers are real people on real links and
  // must never match. Their UAs carry FBAN/FBAV/Instagram, not the crawler token.
  const inAppBrowsers = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/520.0.0.38.101;FBBV/7654321;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0.0 Android',
  ];
  for (const userAgent of inAppBrowsers) {
    assert.equal(withNavigator({ webdriver: false, userAgent }, isSyntheticAgent), false, userAgent);
  }
});

function withScreen<T>(screen: { width: number; height: number } | undefined, fn: () => T): T {
  const realChromeUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.5938.132 Safari/537.36';
  return withNavigator({ webdriver: false, userAgent: realChromeUA }, () => {
    (globalThis as unknown as { window: { screen?: unknown } }).window.screen = screen;
    return fn();
  });
}

test("headless Chrome's default 800x600 screen is caught behind a spoofed UA (E-039)", () => {
  // 120 desktop "visitors" in 60 days to 2026-10-04 sent an ordinary Chrome UA,
  // no webdriver flag, and an 800x600 screen, from datacenter cities, and none
  // ever opened the signup modal. The screen is the only thing they left unset.
  assert.equal(withScreen({ width: 800, height: 600 }, isSyntheticAgent), true);
});

test('real screens, including near misses, are never treated as synthetic', () => {
  for (const screen of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 800, height: 1280 },
    { width: 1280, height: 800 },
    { width: 600, height: 800 },
  ]) {
    assert.equal(withScreen(screen, isSyntheticAgent), false, `${screen.width}x${screen.height}`);
  }
  assert.equal(withScreen(undefined, isSyntheticAgent), false, 'no screen object');
});
