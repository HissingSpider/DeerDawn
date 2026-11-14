import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DEFAULT_KEY_NAME,
  describeKeyCreateFailure,
  isDuplicateKeyName,
  nextDefaultKeyName,
  shouldRetryWithNewName,
} from './apiKeyCreation';

const here = path.dirname(fileURLToPath(import.meta.url));
const keysRoute = readFileSync(path.resolve(here, '../../../api/src/routes/shared/keys.js'), 'utf8');

test('the duplicate refusal is read from the code, not from the prose', () => {
  // THE BUG. /setup branched on `message.includes('conflict')`. The route
  // answers 409 with `error: 'conflict'` and a SENTENCE that has never had the
  // word "conflict" in it — so that branch was dead and every failure, a
  // viewer's 403 included, read "Failed to create key."
  //
  // Pinned by SHAPE, not by the sentence. The wording is the server's to change
  // and already has: #504 moved the duplicate check from per-workspace to
  // per-person, so it now says "You already have an active API Key with this
  // name." What the dashboard depends on is the 409 and the code — and what
  // made the old branch wrong is that the word it searched for lives in neither
  // the sentence nor anywhere else a client can read off `message`.
  const refusalCall = /res\.status\(409\)\.json\(\{\s*error:\s*'conflict',\s*message:\s*'([^']+)'/.exec(keysRoute);
  assert.ok(refusalCall, 'keys.js no longer answers a duplicate name with 409 + error: conflict — re-point this test');
  const serverSentence = refusalCall[1];
  assert.equal(
    /conflict/i.test(serverSentence),
    false,
    'the sentence the old branch searched for "conflict" in still does not contain it',
  );

  const refusal = { status: 409, data: { error: 'conflict', message: serverSentence }, message: serverSentence };
  assert.equal(isDuplicateKeyName(refusal), true);
  // Either half is enough alone, so a server that sends only one is understood.
  assert.equal(isDuplicateKeyName({ status: 409 }), true);
  assert.equal(isDuplicateKeyName({ data: { error: 'conflict' } }), true);
  // And the server's own sentence is what the reader is shown.
  assert.equal(describeKeyCreateFailure(refusal), serverSentence);
});

test('a conflict on a name the PAGE chose is retried once, under a new name', () => {
  const conflict = { status: 409, data: { error: 'conflict' } };
  assert.equal(shouldRetryWithNewName(conflict, true), true);
  assert.equal(nextDefaultKeyName(1), `${DEFAULT_KEY_NAME} 2`);
  // A name the person typed is theirs. Renaming it for them is the page making
  // a decision it was not asked to make.
  assert.equal(shouldRetryWithNewName(conflict, false), false);
  // And nothing else is retried at all.
  assert.equal(shouldRetryWithNewName({ status: 403 }, true), false);
  assert.equal(shouldRetryWithNewName({ status: 500 }, true), false);
});

test('a viewer is told what is actually stopping them', () => {
  // keys.js refuses a role that cannot grant the requested scopes and names
  // them. That sentence is the only version of this failure a reader can act
  // on, so it is shown rather than replaced.
  assert.ok(keysRoute.includes('cannot grant:'), 'keys.js no longer names the refused scopes');
  const refused = {
    status: 403,
    data: { error: 'forbidden', message: 'Your role in this workspace cannot grant: context:write.' },
  };
  assert.match(describeKeyCreateFailure(refused), /cannot grant: context:write/);
  // Even with no message, the answer names the role, not the request.
  assert.match(describeKeyCreateFailure({ status: 403 }), /workspace owner/i);
});

test('every other failure still says something a person can use', () => {
  assert.match(describeKeyCreateFailure({ status: 401 }), /sign in/i);
  assert.match(describeKeyCreateFailure({ status: 429 }), /wait a moment/i);
  assert.match(describeKeyCreateFailure({ status: 500 }), /try again/i);
  assert.match(
    describeKeyCreateFailure({ status: 409, data: { error: 'conflict' } }),
    /different name/i,
    'a duplicate on a typed name has to say what to do about it',
  );
});
