/**
 * The authorize-screen account badge, rendered and read.
 *
 * The badge used to show `user.firstName`. On a screen whose one button grants an
 * AI tool standing access to an account, a first name does not say WHICH account,
 * and there was no way to change it without abandoning the request. These render
 * the presentational half with the real React renderer and assert on the markup,
 * because both halves of the old defect are things only the output shows: what
 * text identifies the account, and whether a control to change it exists at all.
 *
 * A .ts file using createElement, not .tsx, so the existing `src/lib/*.test.ts`
 * glob in `npm test` picks it up.
 *
 * Run: `tsx --test src/lib/authorizeAccountBadge.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountBadgeView } from '../components/AuthorizeAccountBadge';

const render = (props: Partial<Parameters<typeof AccountBadgeView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AccountBadgeView, {
      email: 'john.gilbert@work-example.com',
      name: 'John Gilbert',
      onSwitch: () => undefined,
      ...props,
    }),
  );

/** The `disabled` ATTRIBUTE. The class list also contains the word (`disabled:opacity-60`). */
const isDisabled = (tag: string) => /\sdisabled(=""|\s|>)/.test(tag);

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the badge names the account by its full email address', () => {
  const html = render();
  assert.ok(text(html).includes('john.gilbert@work-example.com'), 'the whole address, domain included');
  assert.ok(!/>John</.test(html), 'a first name alone cannot tell a work account from a personal one');
});

test('the address wraps instead of being clipped', () => {
  const html = render({ email: 'a.very.long.address.that.will.not.fit@subdomain.company-example.com' });
  assert.ok(text(html).includes('a.very.long.address.that.will.not.fit@subdomain.company-example.com'));
  const emailNode = html.match(/<div[^>]*data-testid="authorize-account-email"[^>]*>/);
  assert.ok(emailNode, 'email node missing');
  assert.ok(/break-all/.test(emailNode[0]), 'the address must wrap');
  assert.ok(!/truncate/.test(emailNode[0]), 'truncation hides the domain, the half that matters');
});

test('there is a control to switch account, and it is a real button', () => {
  const html = render();
  const button = html.match(/<button[^>]*>([^<]*)<\/button>/);
  assert.ok(button, 'no button rendered');
  assert.equal(button[1], 'Not you? Switch account');
  assert.ok(/type="button"/.test(button[0]));
  assert.ok(!isDisabled(button[0]));
});

test('while signing out the control is disabled and says so', () => {
  const html = render({ switching: true });
  const button = html.match(/<button[^>]*>([^<]*)<\/button>/);
  assert.ok(button);
  assert.ok(isDisabled(button[0]), 'a second click mid sign-out must not start a second one');
  assert.equal(button[1], 'Signing out…');
});

test('an account with no name still gets initials and its address', () => {
  const html = render({ name: '', email: 'zed@example.com' });
  assert.ok(text(html).includes('ZE'), 'avatar fallback initials come from the address');
  assert.ok(text(html).includes('zed@example.com'));
});
