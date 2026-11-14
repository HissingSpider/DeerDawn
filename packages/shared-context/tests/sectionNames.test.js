const test = require('node:test');
const assert = require('node:assert/strict');

const { formatSectionInjection } = require('../src');

// A SECTION NAME THE FORMATTER DOES NOT KNOW USED TO RETURN THE HEADER AND
// NOTHING ELSE.
//
// `recall({ action: "context", sections: ["current_status"] })` answered with
// just "## Project" — the real name is `status`, and the advertised schema is a
// plain string array with no enum, so nothing anywhere told the caller. The
// caller cannot tell "this project has no status" from "you asked for a section
// that does not exist", and both readings are wrong.
//
// The schema stays as it is (frozen for a review in flight), so this is the only
// place the near-miss can be caught: resolve the unambiguous aliases, and say so
// when a name is still not one.

const CTX = {
  project_name: 'Fixture',
  current_task: 'Ship the section aliases',
  current_status: 'In review',
  recent_decisions: [{ summary: 'One formatter owns section names', importance: 'high' }],
  open_questions: ['Anything else silently dropped?'],
  hot_paths: [{ label: 'Formatter', path: 'packages/shared-context/src/index.js' }],
  todo_items: [{ id: 'card-1', title: 'Pin the aliases', phase: 'backlog' }],
};

const ALIASES = {
  current_task: 'Ship the section aliases',
  current_status: 'In review',
  recent_decisions: 'One formatter owns section names',
  open_questions: 'Anything else silently dropped?',
  paths: 'packages/shared-context/src/index.js',
  tasks: 'Pin the aliases',
};

for (const [alias, expected] of Object.entries(ALIASES)) {
  test(`"${alias}" resolves to the section it obviously means`, () => {
    const body = formatSectionInjection(CTX, [alias]);
    assert.ok(body.includes(expected), `THE BUG: "${alias}" returned the header and nothing else:\n${body}`);
    assert.ok(!body.includes('Not a section name'), `"${alias}" is understood, so nothing is ignored`);
  });
}

test('a name that is still not a section is named, with the valid ones', () => {
  const body = formatSectionInjection(CTX, ['task', 'sprint_velocity']);
  assert.ok(body.includes('Ship the section aliases'), 'the names that ARE understood are still served');
  assert.match(body, /Not a section name: sprint_velocity/);
  assert.match(body, /decisions/, 'the caller is told what it could have asked for');
});

test('asking for the same section twice renders it once', () => {
  const body = formatSectionInjection(CTX, ['task', 'current_task']);
  assert.equal(body.split('Ship the section aliases').length - 1, 1);
});

test('the global selectors are not reported as unknown sections', () => {
  const body = formatSectionInjection(CTX, ['task', 'user', 'prefs'], { user_profile: 'Fixture user' });
  assert.ok(!body.includes('Not a section name'), 'user/prefs select the global block, they are not typos');
  assert.match(body, /Fixture user/);
});

test('no sections asked for is not an unknown section', () => {
  assert.ok(!formatSectionInjection(CTX, []).includes('Not a section name'));
});
