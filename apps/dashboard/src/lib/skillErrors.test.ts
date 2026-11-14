import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from './api';
import { canEditSkill, skillRefusalMessage } from './skillErrors';

function refusal(data: Record<string, unknown>) {
  return new ApiError(403, 'Request failed', undefined, undefined, undefined, data);
}

test('a refused skill write is explained in the API\'s own words', () => {
  const err = refusal({ error: 'skill_write_forbidden', message: 'Your role in this workspace is read-only, so you cannot change its shared skills.' });
  assert.equal(skillRefusalMessage(err), 'Your role in this workspace is read-only, so you cannot change its shared skills.');
});

test('a refusal with no sentence still says it is a refusal, not a fault', () => {
  assert.match(skillRefusalMessage(refusal({ error: 'skill_write_forbidden' })) || '', /workspace owner/);
});

test('anything else is left to the caller', () => {
  assert.equal(skillRefusalMessage(refusal({ error: 'skills_limit_exceeded' })), null);
  assert.equal(skillRefusalMessage(new Error('network down')), null);
});

test('only an explicit refusal hides the edit controls', () => {
  assert.equal(canEditSkill({ can_edit: false }), false);
  assert.equal(canEditSkill({ can_edit: true }), true);
  // An API that predates the field must not make every skill read-only.
  assert.equal(canEditSkill({}), true);
});
