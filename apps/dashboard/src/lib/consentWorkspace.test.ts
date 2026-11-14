import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { consentWorkspace } from './consentWorkspace';
import { ConsentWorkspaceNotice } from '../components/ConsentWorkspaceNotice';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
const listing = {
  active: 'org-team',
  workspaces: [
    { workspace: 'org-own', name: 'Sarah workspace', personal: true },
    { workspace: 'org-team', name: 'Acme Engineering', personal: false },
  ],
};

test('the team the person is working in is the one named', () => {
  assert.deepEqual(consentWorkspace(listing), { name: 'Acme Engineering', personal: false });
});

test('a personal workspace reads as the person\'s own, not by its stored name', () => {
  assert.deepEqual(consentWorkspace({ ...listing, active: 'org-own' }), { name: 'your personal workspace', personal: true });
});

test('a lapsed team that is being served from their own workspace names the one the approval lands in', () => {
  assert.deepEqual(
    consentWorkspace({ ...listing, fallback: { to: 'org-own' } }),
    { name: 'your personal workspace', personal: true },
  );
});

test('an unreadable listing names nothing rather than guessing', () => {
  assert.equal(consentWorkspace(null), null);
  assert.equal(consentWorkspace({ active: 'org-x', workspaces: listing.workspaces }), null);
  assert.equal(consentWorkspace({ workspaces: listing.workspaces }), null);
});

test('the consent copy names the workspace and says it is permanent', () => {
  const said = text(renderToStaticMarkup(createElement(ConsentWorkspaceNotice, { workspace: { name: 'Acme Engineering', personal: false } })));
  assert.match(said, /This connection will work in Acme Engineering, and only there\./);
  assert.match(said, /To use it in another workspace, approve it again from that workspace\./);
});

test('without a name the copy still says the true part, with no emoji', () => {
  const said = text(renderToStaticMarkup(createElement(ConsentWorkspaceNotice, { workspace: null })));
  assert.match(said, /This connection will work in the workspace you are in now, and only there\./);
  assert.doesNotMatch(said, /\p{Extended_Pictographic}/u);
});
