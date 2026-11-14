/**
 * JOURNEY R4 — THE DATA PAGE SAYS WHAT THE DOWNLOAD HOLDS.
 *
 * /settings/data said "Everything DeerDawn holds for you" above a download that
 * left out switched-off skills (and that was never everything: the history
 * behind the brief is not in it). The owner's decision: the sentence lists what
 * the download holds (profile, preferences, projects, knowledge graph, skills),
 * and the download carries switched-off skills, marked
 * (apps/api tests/integration/journey-r4-export-switched-off-skills.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'settings', 'data.tsx'), 'utf8');

test('the page no longer claims the download is everything DeerDawn holds', () => {
  assert.doesNotMatch(page, /Everything DeerDawn holds/);
});

test('it lists what the download holds, skills included', () => {
  const description = (page.match(/description="([^"]+)"/) || [])[1] || '';
  for (const item of ['profile', 'preferences', 'projects', 'knowledge graph', 'skills']) {
    assert.match(description, new RegExp(item), `the page's sentence names ${item}`);
  }
  assert.match(page, /switched off/, 'and says switched-off skills are in it');
});
