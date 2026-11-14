import test from 'node:test';
import assert from 'node:assert';
import {
  connectionPersonName,
  connectionToolName,
  disconnectConfirmation,
  TEAM_CONNECTIONS_EMPTY,
  TEAM_CONNECTIONS_INTRO,
} from './teamConnections';

const colleague = {
  client_name: 'Claude',
  person: { user_id: 'user-1', display_name: 'sarah@acme.com' },
  own: false,
};

test('the confirmation names the tool and the person, and says what is left alone', () => {
  const text = disconnectConfirmation(colleague);
  assert.match(text, /sarah@acme\.com's Claude/);
  assert.match(text, /It stops working right away/);
  assert.match(text, /Nothing in the workspace is deleted/);
  assert.match(text, /sarah@acme\.com can connect it again/);
});

test('the owner is not told a colleague will reconnect their own tool', () => {
  const text = disconnectConfirmation({ ...colleague, own: true });
  assert.match(text, /your Claude/);
  assert.doesNotMatch(text, /sarah@acme\.com/);
});

test('an unnamed connection still reads as a thing, not as blank', () => {
  assert.strictEqual(connectionToolName({ client_name: null }), 'An unnamed app');
  assert.strictEqual(connectionToolName({ client_name: '  ' }), 'An unnamed app');
  assert.match(disconnectConfirmation({ ...colleague, client_name: null }), /unnamed app/);
});

test('a person is named, and the owner is "You"', () => {
  assert.strictEqual(connectionPersonName(colleague), 'sarah@acme.com');
  assert.strictEqual(connectionPersonName({ ...colleague, own: true }), 'You');
});

test('the section says a connection stays in its workspace, and holds no emoji', () => {
  assert.match(TEAM_CONNECTIONS_INTRO, /only in the workspace it was approved for/);
  assert.doesNotMatch(TEAM_CONNECTIONS_INTRO, /before this list existed|not shown/);
  for (const text of [TEAM_CONNECTIONS_INTRO, TEAM_CONNECTIONS_EMPTY, disconnectConfirmation(colleague)]) {
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
  }
});
