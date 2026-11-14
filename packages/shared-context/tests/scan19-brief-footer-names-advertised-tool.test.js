'use strict';

/**
 * Scan 19: the brief footer told the model to call `get_context(sections=["all"])`.
 *
 * get_context is dispatchable but is not in tools/list on either the hosted or
 * the local server, so a model following the footer reached for a tool it had
 * never been shown — the same defect as the first-run copy that named
 * update_context. The advertised route to the same read is recall with action
 * "context", on both surfaces.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatConversationalInjection, formatCodeInjection } = require('../src');

const long = 'word '.repeat(80);
const crowded = {
  project_name: 'P',
  current_task: long,
  current_status: long,
  description: long,
  goals: [long, long],
  tech_stack: ['a', 'b'],
  recent_decisions: [{ summary: long, made_at: new Date().toISOString() }],
  open_questions: [long],
  recurring_context: [long],
  blocking_issue: long,
  next_action: long,
  commands: [{ label: 't', run: 'npm test' }],
};

for (const [name, format] of [['conversational', formatConversationalInjection], ['code', formatCodeInjection]]) {
  for (const verbosity of ['light', 'standard']) {
    test(`${name}/${verbosity}: the full-context footer names recall, never get_context`, () => {
      const body = format(crowded, verbosity).body;
      const footer = body.split('\n').filter((line) => /full context/.test(line));
      assert.ok(footer.length, 'the crowded fixture produces a footer (omitted or ellipsized)');
      for (const line of footer) {
        assert.ok(!line.includes('get_context'), `unadvertised tool named: ${line}`);
        assert.ok(line.includes('recall(action="context", sections=["all"])'), line);
      }
    });
  }
}
