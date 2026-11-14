const test = require('node:test');
const assert = require('node:assert');
const { getToolProfile, listSupportedTools } = require('../src/index.js');

test('tool adapter package exposes browser and code tool profiles', () => {
  const tools = listSupportedTools();
  assert.ok(tools.length >= 3);
  assert.strictEqual(getToolProfile('cursor').injection, 'rules-file');
  assert.strictEqual(getToolProfile('claude_web').surface, 'browser');
});
