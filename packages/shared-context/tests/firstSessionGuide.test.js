const test = require('node:test');
const assert = require('node:assert');
const { buildFirstSessionGuide, INTERVIEW_QUESTIONS } = require('../src/firstSessionGuide');

test('both variants start the brief from what is already here, and keep the interview as a fallback', () => {
  for (const local of [true, false]) {
    // Local: the variant for somebody who said yes to seeding at setup.
    const guide = buildFirstSessionGuide({ local, readRepoWithoutAsking: local });
    assert.match(guide, /No DeerDawn context yet/);
    assert.match(guide, /without stopping to ask/);
    assert.match(guide, /what the user has said in this conversation/);
    for (const q of INTERVIEW_QUESTIONS) assert.ok(guide.includes(q), `${local ? 'local' : 'hosted'} guide is missing: ${q}`);
    assert.match(guide, /manage_projects\(action:"create"\)/);
    assert.match(guide, /manage_memory\(action:"update"\)/);
    assert.match(guide, /never fill gaps with guesses/);
    assert.match(guide, /do not invent one/);
  }
});

test('it no longer opens with a question the model has to wait on (E-035)', () => {
  // The routing question was the first step, and the 2 connected ChatGPT users
  // who were shown it made no second tool call. The interview questions may
  // only come after the user's own request has been answered.
  for (const local of [true, false]) {
    const guide = buildFirstSessionGuide({ local });
    assert.doesNotMatch(guide, /codebase that already exists, or a new project/);
    assert.doesNotMatch(guide, /Ask the user one question/);
    assert.ok(
      guide.indexOf('manage_projects(action:"create")') < guide.indexOf(INTERVIEW_QUESTIONS[0]),
      'saving must come before the fallback interview',
    );
    assert.match(guide, /Answer the user, then ask/);
  }
});

test('the user is told what was saved, so session one shows something', () => {
  for (const local of [true, false]) {
    assert.match(buildFirstSessionGuide({ local }), /DeerDawn saved:/);
  }
});

test('only the local guide offers import_local; the hosted one allows for tools that cannot read files', () => {
  assert.match(buildFirstSessionGuide({ local: true }), /manage_memory\(action:"import_local"\)/);
  const hosted = buildFirstSessionGuide();
  assert.doesNotMatch(hosted, /import_local/, 'the hosted server has no import_local action');
  assert.match(hosted, /cannot read files/);
});

test('it names only DeerDawn tools the dispatchers advertise, never update_context', () => {
  // update_context is dispatchable but not in tools/list; naming it broke first
  // saves on hosted connectors once already.
  for (const local of [true, false]) {
    assert.doesNotMatch(buildFirstSessionGuide({ local }), /update_context|create_project\b/);
  }
});

test('it does not tell the model to put a call ahead of answering the user', () => {
  // A tool result, not an app-level directive: the ChatGPT review rejected a
  // "call this before your first response" style instruction once already.
  for (const local of [true, false]) {
    assert.doesNotMatch(buildFirstSessionGuide({ local }), /before (your|you) (first )?(respon|answer|reply)/i);
  }
});

test('local, without a yes at setup: ask once before reading the repo (Thing 4.5)', () => {
  for (const options of [{ local: true }, { local: true, readRepoWithoutAsking: false }]) {
    const guide = buildFirstSessionGuide(options);
    assert.doesNotMatch(guide, /without stopping to ask/);
    assert.match(guide, /Ask the user once before reading anything here/);
    assert.match(guide, /Read them only after a yes/);
    assert.match(guide, /After a no, or with no codebase here: use what the user has said in this conversation/);
    // The rest of the guide is the same: save, then say what was saved.
    assert.match(guide, /manage_memory\(action:"import_local"\)/);
    assert.match(guide, /DeerDawn saved:/);
  }
});

test('the hosted guide is not affected by the local seeding answer', () => {
  assert.strictEqual(buildFirstSessionGuide({ readRepoWithoutAsking: false }), buildFirstSessionGuide());
  assert.match(buildFirstSessionGuide(), /without stopping to ask/);
});

test('the hosted guide handles "add the projects I am working on" from what the tool already knows', () => {
  // The consent screen's first message (2026-10-06) asks ChatGPT or Claude to
  // add every project it knows from earlier chats; one project per project.
  const hosted = buildFirstSessionGuide();
  assert.match(hosted, /earlier chats or memory/);
  assert.match(hosted, /one project per project, each with its own brief/);
  assert.doesNotMatch(buildFirstSessionGuide({ local: true }), /earlier chats or memory/);
});
