import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CONSENT_FIRST_PROMPT, consentToolLabel, copyFirstPrompt } from './consentNextStep';
import { ConsentNextStep } from '../components/ConsentNextStep';

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const render = (clientName: string | null, verified: boolean) =>
  text(renderToStaticMarkup(createElement(ConsentNextStep, { clientName, verified })));

test('a verified ChatGPT approval is told Connect copies the message and where to paste it', () => {
  const copy = render('ChatGPT', true);
  assert.match(copy, /Connect copies your first message/);
  assert.match(copy, /start a new chat in ChatGPT/);
  assert.ok(copy.includes(CONSENT_FIRST_PROMPT));
});

test('the first message fills the brief from what the tool already knows, not just opens a session', () => {
  // 22 of 23 signups to 10-06 came through this screen and skipped onboarding,
  // so "Start my DeerDawn session" opened an empty account. The message has to
  // name DeerDawn (so the chat routes to it) and ask for the projects.
  assert.match(CONSENT_FIRST_PROMPT, /DeerDawn/);
  assert.match(CONSENT_FIRST_PROMPT, /projects I'm working on/);
  assert.match(CONSENT_FIRST_PROMPT, /earlier chats/);
  assert.match(CONSENT_FIRST_PROMPT, /Skip any DeerDawn already has/);
});

test('copyFirstPrompt writes the message and never throws', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const set = (value: unknown) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try {
    let written = '';
    set({ clipboard: { writeText: async (t: string) => { written = t; } } });
    assert.equal(await copyFirstPrompt(), true);
    assert.equal(written, CONSENT_FIRST_PROMPT);

    set({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
    assert.equal(await copyFirstPrompt(), false);

    set({ clipboard: { writeText: () => { throw new Error('sync'); } } });
    assert.equal(await copyFirstPrompt(), false);

    set({});
    assert.equal(await copyFirstPrompt(), false);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('the old promise that it works with nothing left to do is gone', () => {
  assert.doesNotMatch(render('ChatGPT', true), /automatically/);
});

test('a self-registered client is never named, whatever it calls itself', () => {
  assert.equal(consentToolLabel('ChatGPT', false), null);
  assert.match(render('ChatGPT', false), /start a new chat in your AI tool/);
});

test('only the tools named everywhere else are named here', () => {
  assert.equal(consentToolLabel('Claude', true), 'Claude');
  assert.equal(consentToolLabel('OpenAI ChatGPT', true), 'ChatGPT');
  assert.equal(consentToolLabel('Cursor', true), null);
  assert.equal(consentToolLabel(null, true), null);
});

test('revocation is still said before the button', () => {
  assert.match(render(null, false), /revoke access any time/);
});
