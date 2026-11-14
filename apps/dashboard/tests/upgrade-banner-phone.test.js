/**
 * JOURNEY R3 / S3-2 — on a phone the Free upgrade banner was clipped on every
 * signed-in page.
 *
 * The bar was one fixed-height (`h-11`), centred (`justify-center`), no-wrap
 * (`whitespace-nowrap`) row about 1,000px wide. In a 375px screen, inside a
 * shell that clips horizontal overflow, the centring put the sentence from
 * x=-368 to x=652 and Upgrade (x=663) and Dismiss (x=749) past the right edge:
 * a strip reading "ross-project search, the entities that show up in more than
 * one" and nothing to tap.
 *
 * What this pins, without a browser:
 *   - every change is phone-only: strip the `max-sm:` classes and the phone-only
 *     element, and the desktop markup is byte-for-byte what it was;
 *   - the phone row can grow, starts at the left and wraps its sentence;
 *   - Upgrade and Dismiss are at least 40px tall on a phone;
 *   - the phone sentence is made ONLY of words the banner already says, and
 *     offers nothing the full sentence does not.
 * The rendered measurements (320, 375, 414 and 1440 wide) are taken by the
 * browser run recorded with the fix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard', 'UpgradeBanner.tsx'), 'utf8');
const planCopy = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'planCopy.ts'), 'utf8');

const classNames = () => [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
const withoutPhone = (cls) => cls.split(/\s+/).filter((c) => c && !c.startsWith('max-sm:')).join(' ');

// The desktop bar as it was before the fix, class for class, in document order.
const DESKTOP_BEFORE = [
  'flex h-11 w-full shrink-0 items-center justify-center gap-3 border-b border-primary/[0.14] bg-primary/[0.07] px-4',
  'shrink-0',
  'whitespace-nowrap text-[13px] text-text-secondary',
  'text-text-primary',
  'shrink-0 whitespace-nowrap rounded-lg bg-primary px-3 py-1 text-[12px] font-semibold text-[#03120b] no-underline',
  'ml-1 flex shrink-0 cursor-pointer items-center rounded-md border-none bg-transparent p-1 text-text-muted',
];

test('desktop is unchanged: without the max-sm: classes and the phone-only sentence, the bar is what it was', () => {
  const phoneOnly = (cls) => /(^|\s)hidden(\s|$)/.test(cls) && /(^|\s)max-sm:inline(\s|$)/.test(cls);
  const all = classNames();
  const phoneIdx = all.findIndex(phoneOnly);
  assert.ok(phoneIdx >= 0, 'there is a phone-only sentence, hidden above the phone breakpoint');
  // The phone sentence and its inner span are not on screen on desktop.
  const desktop = all.filter((_, i) => i !== phoneIdx && i !== phoneIdx + 1).map(withoutPhone);
  assert.deepEqual(desktop, DESKTOP_BEFORE);
});

test('THE BUG: on a phone the row may grow, starts at the left, and the sentence wraps', () => {
  const [row] = classNames();
  assert.match(row, /max-sm:h-auto/, 'a fixed 44px row cannot hold a wrapped sentence');
  assert.match(row, /max-sm:justify-start/, 'centring an overflowing row pushes its start off the left edge');
  const full = classNames().find((c) => c.includes('whitespace-nowrap text-[13px]'));
  assert.match(full, /max-sm:hidden/, 'the thousand-pixel sentence is not what a phone shows');
  const phone = classNames().find((c) => /(^|\s)hidden(\s|$)/.test(c) && c.includes('max-sm:inline'));
  assert.doesNotMatch(phone, /whitespace-nowrap/);
  assert.match(phone, /min-w-0/, 'it may shrink below its text width, so it wraps instead of pushing the buttons out');
  assert.match(phone, /flex-1/);
});

test('Upgrade and Dismiss are at least 40px tall on a phone', () => {
  const link = classNames().find((c) => c.includes('bg-primary px-3'));
  assert.match(link, /max-sm:min-h-\[40px\]/, 'in px: the root font is under 16px, so min-h-10 measured 35px');
  assert.match(link, /max-sm:inline-flex/, 'min-height does nothing on an inline element');
  const dismiss = classNames().find((c) => c.includes('cursor-pointer'));
  assert.match(dismiss, /max-sm:h-\[40px\]/);
  assert.match(dismiss, /max-sm:w-\[40px\]/);
});

test('the phone sentence is made only of words the banner already says', () => {
  const valueLine = (planCopy.match(/PRO_VALUE_LINE =\s*'([^']+)'/) || [])[1];
  assert.ok(valueLine, 'PRO_VALUE_LINE is read from planCopy');
  assert.match(src, /PRO_VALUE_HEAD = PRO_VALUE_LINE\.split\(':'\)\[0\]\.trim\(\)/);
  const head = valueLine.split(':')[0].trim();
  assert.equal(head, 'everything across your projects');
  // The phone form, rendered with the same constants as the full one.
  const phone = `You're on Free — Pro adds ${head}, for $X/mo.`;
  const full = `You're on Free — Pro adds ${valueLine}, for $X/mo.`;
  const words = (s) => s.toLowerCase().match(/[a-z$/']+/g);
  for (const word of words(phone)) assert.ok(words(full).includes(word), `"${word}" is not in the full sentence`);
  // Same plan, same price constants, no new claim.
  assert.match(src, /\{`\$\{PRO_PLAN_NAME\} adds \$\{PRO_VALUE_HEAD\}, for \$\{MONTHLY_LABEL\}\.`\}/);
});

test('when the banner shows is untouched', () => {
  assert.match(src, /const visible = capped && briefed && !dismissed;/);
  assert.match(src, /href="\/settings\/upgrade\?trigger=upgrade_banner"/);
});
