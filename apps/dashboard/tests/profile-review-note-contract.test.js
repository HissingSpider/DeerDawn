/**
 * JOURNEY R5 - THE ONE-TIME NOTE ON THE YOU PAGE.
 *
 * A profile that existed before extraction stopped filling it may hold lines
 * lifted from the person's projects. Nothing is deleted. The You panel says so
 * once, in plain words, and never again after the person dismisses it or saves
 * their profile. The marker is server side (context_globals.profile_reviewed_at,
 * GET /context/global review_needed, POST /context/global/review), so this pins
 * that the panel asks the server and does not keep the answer in the browser.
 * The lines that were lifted (goals, expertise, values, working style) are shown
 * and editable there, or the person could not check them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\{\/\*)/.test(line))
  .join('\n');

const network = stripComments(read('src', 'components', 'dashboard', 'ContextNetwork.tsx'));
const apiLib = stripComments(read('src', 'lib', 'api.ts'));

test('the api client asks the server whether the note is due, and can dismiss it', () => {
  assert.match(apiLib, /getProfileReviewNeeded/);
  assert.match(apiLib, /fetchAPI\('\/api\/v1\/context\/global'\)[\s\S]{0,80}review_needed/);
  assert.match(apiLib, /dismissProfileReview[\s\S]{0,120}\/api\/v1\/context\/global\/review[\s\S]{0,60}method: 'POST'/);
});

test('the You panel shows the note from the server answer, in plain words, until dismissed or saved', () => {
  assert.match(network, /api\.getProfileReviewNeeded\(\)/);
  assert.match(network, /Some of this may have been filled in automatically from your projects\. Please check it\./);
  assert.match(network, /api\.dismissProfileReview\(\)/);
  const save = network.slice(network.indexOf('async function saveEdit'), network.indexOf('async function handleDelete') > 0 ? network.indexOf('async function handleDelete') : undefined);
  assert.match(save, /setReviewNeeded\(false\)/, 'saving the profile settles the note');
  assert.doesNotMatch(network, /localStorage[\s\S]{0,80}review/i, 'the answer is the server\'s, not the browser\'s');
});

test('the lines that were lifted from projects are shown and editable on the You panel', () => {
  for (const key of ['goals', 'expertise_areas', 'values', 'working_style', 'communication_preferences']) {
    assert.match(network, new RegExp(key), `${key} is on the panel`);
  }
  assert.match(network, /_prefs:/, 'the panel loads what is stored before offering to edit it');
});
