/**
 * Renderers must tell "withheld" apart from "empty".
 *
 * Every formatter here follows omit-not-fabricate: an empty section prints
 * nothing rather than an empty header. That is right for a section nobody has
 * written and wrong for one a share policy is withholding — and on the wire the
 * two are identical, because both are just a missing key.
 *
 * The API stamps `withheld_sections` onto a section-filtered context. These
 * tests pin that every user-facing render path acts on it, and that a context
 * WITHOUT the marker is rendered exactly as before (the owner's own brief must
 * not grow a line about sharing).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatWithheldSectionsLine,
  withheldSectionLabels,
  formatSectionInjection,
  formatBriefInjection,
  formatConversationalInjection,
  formatCodeInjection,
} = require('../src/index.js');

/** A member's filtered view: current_task shared, everything else withheld. */
function filteredContext(extra = {}) {
  return {
    project_name: 'WithheldProj',
    current_task: 'Ship the share policy',
    withheld_sections: ['description', 'goals', 'recent_decisions', 'todo_items'],
    ...extra,
  };
}

test('the withheld line names the sections and denies that they are empty', () => {
  const line = formatWithheldSectionsLine(filteredContext());
  assert.ok(line, 'a filtered context produces a line');
  assert.match(line, /Not shared with you/);
  for (const label of ['description', 'goals', 'decisions', 'task board']) {
    assert.ok(line.includes(label), `names ${label} in human words, not field names`);
  }
  // The load-bearing half: without this a reader still concludes "nothing here".
  assert.match(line, /not empty/);
});

test('an unfiltered context produces no line at all', () => {
  assert.equal(formatWithheldSectionsLine({ project_name: 'Mine' }), null);
  assert.equal(formatWithheldSectionsLine({ project_name: 'Mine', withheld_sections: [] }), null);
  assert.equal(formatWithheldSectionsLine(null), null);
  assert.deepEqual(withheldSectionLabels(undefined), []);
});

test('an unknown section name still renders, readably', () => {
  // A section added to the API ahead of this label table must degrade to
  // something a human can read, never to a dropped line or "undefined".
  const line = formatWithheldSectionsLine({ withheld_sections: ['some_new_section'] });
  assert.ok(line.includes('some new section'), 'unknown keys fall back to de-underscored text');
});

test('formatSectionInjection says a requested section was withheld', () => {
  const out = formatSectionInjection(filteredContext(), ['all']);
  assert.match(out, /Not shared with you/, 'the withheld line is part of the section render');
  assert.ok(!out.includes('Goals:'), 'no fabricated empty header for a withheld section');

  const unfiltered = formatSectionInjection({ project_name: 'Mine', current_task: 'x' }, ['all']);
  assert.ok(!unfiltered.includes('Not shared with you'), 'an owner sees no sharing chatter');
});

test('formatBriefInjection does not claim "No brief captured yet" over a withheld brief', () => {
  // Every slot is empty ONLY because the policy emptied them.
  const body = formatBriefInjection(filteredContext()).body;
  assert.ok(
    !body.includes('No brief captured yet'),
    'that sentence is a claim about the project, and here it is false'
  );
  assert.match(body, /Not shared with you/);

  const genuinelyEmpty = formatBriefInjection({ project_name: 'Mine' }).body;
  assert.match(
    genuinelyEmpty,
    /No brief captured yet/,
    'a genuinely empty brief still says so — this is not a blanket replacement'
  );
});

test('formatBriefInjection keeps the withheld line when slots DO render', () => {
  const body = formatBriefInjection(filteredContext({
    open_questions: ['Which price do we ship?'],
  })).body;
  assert.match(body, /Which price do we ship\?/, 'the shared slot still renders');
  assert.match(body, /Not shared with you/, 'a partial view that looks complete is the worse failure');
});

test('the conversational and code injections both carry the line', () => {
  const conversational = formatConversationalInjection(filteredContext()).body;
  assert.match(conversational, /Not shared with you/);

  const code = formatCodeInjection(filteredContext()).body;
  assert.match(code, /Not shared with you/);
  // The code format is comment-syntax throughout; an uncommented line would be
  // read as content by whatever consumes it.
  const withheldLine = code.split('\n').find((l) => l.includes('Not shared with you'));
  assert.ok(withheldLine.startsWith('# '), 'the code format comments its own notice');
});

test('the withheld line is distinct from the token-budget omission notice', () => {
  // They mean opposite things: "ask me again" vs "you may not have it". A
  // reader told the wrong one loops on a retry that can never succeed.
  const line = formatWithheldSectionsLine(filteredContext());
  assert.ok(!line.includes('get_context'), 'never suggests a retry that cannot work');
  assert.match(line, /share/, 'points at the action that CAN work');
});
