import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ACCOUNT_ERASURE_PHRASE,
  describeErasedRows,
  describeErasureFailure,
  erasurePhraseMatches,
} from './accountErasure';

const here = path.dirname(fileURLToPath(import.meta.url));
const route = readFileSync(
  path.resolve(here, '../../../api/src/routes/context/context-sync.js'),
  'utf8',
);

test('the phrase is the one the route actually compares against', () => {
  // The page shipped for months sending NO confirmation at all, so this is
  // pinned the way planCopy is pinned to plans.js: the route is CommonJS and
  // cannot be imported here, so its literal is read as text.
  assert.ok(
    route.includes(`req.body?.confirmation !== '${ACCOUNT_ERASURE_PHRASE}'`),
    'DELETE /context/account no longer compares against this phrase — re-point the dashboard',
  );
});

test('the route answers with `deleted`, and has never answered with a confirmation token', () => {
  // The old page rendered success only when a `confirmation_token` came back.
  // No such field exists, so the success state was unreachable even on the day
  // the request was otherwise correct.
  // Pinned by FIELD, not by the whole statement. The response gained
  // `left_workspaces` and a `message` (for a while it named teams the person
  // was removed from; since scan 24 the route leaves other workspaces alone and
  // `left_workspaces` is always empty), and a pin on the exact line went red over fields this page
  // does not read. What the page depends on is the three it does read, inside
  // the one success response of DELETE /account.
  const start = route.indexOf("router.delete('/account'");
  assert.ok(start > -1, 'DELETE /account is no longer declared in context-sync.js');
  const handler = route.slice(start, route.indexOf('\nrouter.', start + 1));
  const success = handler.match(/return res\.json\(\{([\s\S]*?)\}\);/);
  assert.ok(success, 'DELETE /account no longer answers with a JSON object');
  for (const field of ['deleted: true', 'deleted_counts:', 'subscription_cancelled:']) {
    assert.ok(success[1].includes(field), `the success response no longer carries \`${field}\``);
  }
  assert.ok(
    !/confirmation_token/.test(route),
    'if the route ever starts issuing one, the page has to be taught to read it',
  );
});

test('the button stays shut until the phrase is written out', () => {
  assert.equal(erasurePhraseMatches(ACCOUNT_ERASURE_PHRASE), true);
  // Invisible whitespace is forgiven; the canonical constant is what is sent.
  assert.equal(erasurePhraseMatches(`  ${ACCOUNT_ERASURE_PHRASE}\n`), true);
  // Case is not. A typed confirmation exists so it cannot happen by accident,
  // and the lower-case form is pasteable from this page's own prose.
  assert.equal(erasurePhraseMatches('delete my deerdawn account'), false);
  assert.equal(erasurePhraseMatches('DELETE MY DEERDAWN ACCOUNT!'), false);
  assert.equal(erasurePhraseMatches('DELETE'), false);
  assert.equal(erasurePhraseMatches(''), false);
  assert.equal(erasurePhraseMatches(undefined), false);
});

test('each refusal says which one it was, and that nothing was deleted', () => {
  const members = describeErasureFailure(409, {
    error: 'workspace_has_members',
    message: 'This workspace has other members. Remove them first, or leave the workspace instead of deleting it.',
  });
  assert.match(members, /other members/);

  const billing = describeErasureFailure(502, { error: 'billing_cancellation_failed' });
  assert.match(billing, /subscription could not be cancelled/i);
  assert.match(billing, /nothing was deleted/i);

  const forbidden = describeErasureFailure(403, { error: 'forbidden' });
  assert.match(forbidden, /workspace owner/i);

  const unconfirmed = describeErasureFailure(400, { error: 'confirmation_required' });
  assert.match(unconfirmed, new RegExp(ACCOUNT_ERASURE_PHRASE));

  // Anything unrecognised still has to promise the one thing that matters.
  assert.match(describeErasureFailure(500, null), /nothing was deleted/i);
});

test('the success state can say how much actually went', () => {
  assert.equal(describeErasedRows({ context_projects: 3, context_sessions: 11 }), '14 records were removed.');
  assert.equal(describeErasedRows({ context_projects: 1 }), '1 record was removed.');
  // An empty workspace is a real outcome, and inventing a number for it would
  // be the same kind of lie the old success banner told.
  assert.equal(describeErasedRows({ context_projects: 0 }), null);
  assert.equal(describeErasedRows(null), null);
});
