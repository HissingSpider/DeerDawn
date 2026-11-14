/**
 * Project category discriminator (P2 of universal life-context).
 *
 * DeerDawn now tracks non-coding "topics" (a trip, a move, an event) alongside
 * coding projects, via a `category` field. This guards: legacy contexts default
 * to 'coding' (no backfill), the field survives a merge that doesn't re-set it,
 * and coding-only fields (tech stack, hot paths, commands, files) are suppressed
 * from the injected brief for topics while staying for coding projects. Pure (no DB).
 *
 * Run: node tests/unit/context-category.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextObject,
  mergeContextObject,
  ContextObjectSchema,
  ContextDeltaSchema,
  formatConversationalInjection,
  formatCodeInjection,
  formatMapInjection,
} = require('../../../../packages/shared-context/src/index.js');

const codingCtx = (extra = {}) => createContextObject({
  project_name: 'API service',
  category: 'coding',
  tech_stack: ['node', 'postgres'],
  hot_paths: [{ label: 'server', path: 'src/server.js' }],
  commands: [{ label: 'test', run: 'npm test' }],
  current_task: 'ship the route',
  ...extra,
});

const topicCtx = (extra = {}) => createContextObject({
  project_name: 'Mount Shasta climb',
  category: 'topic',
  tech_stack: ['node'], // should be ignored for a topic even if present
  hot_paths: [{ label: 'gear', path: 'gear.md' }], // also ignored for a topic
  current_task: 'finalize the gear list',
  ...extra,
});

test('legacy contexts (no category) default to coding; explicit topic round-trips', () => {
  const legacy = ContextObjectSchema.parse({ project_name: 'Old', last_updated: new Date().toISOString() });
  assert.equal(legacy.category, 'coding', 'no migration needed — defaults to coding');
  assert.equal(createContextObject({ project_name: 'T', category: 'topic' }).category, 'topic');
  assert.ok(ContextDeltaSchema.parse({ category: 'topic' }).category === 'topic', 'delta accepts category');
});

test('category survives a merge that does not re-set it', () => {
  const merged = mergeContextObject(topicCtx(), { current_status: 'training started' }, 'src');
  assert.equal(merged.category, 'topic', 'merge preserves the existing category');
});

test('category is sticky: a topic never downgrades to coding via a delta', () => {
  // A later extraction turn that (mis)classifies the topic as coding must not flip it.
  const merged = mergeContextObject(topicCtx(), { category: 'coding', current_status: 'x' }, 'src');
  assert.equal(merged.category, 'topic', 'topic stays a topic');
  // But a coding project CAN still be promoted to a topic.
  const promoted = mergeContextObject(codingCtx(), { category: 'topic' }, 'src');
  assert.equal(promoted.category, 'topic', 'coding can be promoted to topic');
});

test('topic conversational brief suppresses coding-only fields', () => {
  const topic = formatConversationalInjection(topicCtx(), 'standard').body;
  assert.doesNotMatch(topic, /Hot paths:/, 'no hot paths for a life topic');
  assert.match(topic, /Current task: finalize the gear list/, 'still shows the task');

  const coding = formatConversationalInjection(codingCtx(), 'standard').body;
  assert.match(coding, /Hot paths:/, 'coding project still shows hot paths');
});

test('topic code-surface brief suppresses stack/commands/files/hot paths', () => {
  const topic = formatCodeInjection(topicCtx(), 'standard').body;
  assert.doesNotMatch(topic, /Tech stack:|Commands:|Hot paths:|Relevant files:/, 'no coding fields for a topic');

  const coding = formatCodeInjection(codingCtx(), 'standard').body;
  assert.match(coding, /Tech stack:/, 'coding project keeps its stack');
});

test('map brief omits the stack= chip for topics', () => {
  const mapTopic = formatMapInjection(
    [{ project_id: 'p1', project_name: 'Mount Shasta climb', context: topicCtx(), updated_at: new Date().toISOString() }],
    null, {},
  );
  assert.doesNotMatch(mapTopic, /stack=/, 'no stack chip for a topic');

  const mapCoding = formatMapInjection(
    [{ project_id: 'p2', project_name: 'API service', context: codingCtx(), updated_at: new Date().toISOString() }],
    null, {},
  );
  assert.match(mapCoding, /stack=/, 'coding project shows its stack chip');
});
