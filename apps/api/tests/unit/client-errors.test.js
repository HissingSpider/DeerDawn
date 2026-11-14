const assert = require('node:assert');
const test = require('node:test');

const { clientErrorStatus, clientErrorBody } = require('../../src/utils/clientErrors');

function err(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

test('clientErrorStatus', async (t) => {
  await t.test('treats any error carrying a publicMessage as a client error', () => {
    // The whole point of central classification: a brand-new validation error is
    // correctly a 400 without touching a route or a registry.
    assert.strictEqual(clientErrorStatus(err('some_brand_new_validation_code', { publicMessage: 'fix it like so' })), 400);
  });

  await t.test('applies the registry status for codes that are not a plain 400', () => {
    assert.strictEqual(clientErrorStatus(err('duplicate_project_name', { publicMessage: 'taken' })), 409);
    assert.strictEqual(clientErrorStatus(err('project_has_subprojects', { publicMessage: 'nested' })), 409);
    assert.strictEqual(clientErrorStatus(err('project_limit_exceeded', { publicMessage: 'upgrade' })), 422);
  });

  await t.test('still classifies the legacy bare codes that carry no publicMessage', () => {
    assert.strictEqual(clientErrorStatus(err('parent_project_not_found')), 404);
    assert.strictEqual(clientErrorStatus(err('subproject_depth_exceeded')), 400);
    assert.strictEqual(clientErrorStatus(err('low_value_workspace_entity')), 400);
  });

  await t.test('classifies the structural-mutation refusals contextSyncService throws bare', () => {
    // These reached errorHandler unclassified, so archiving a parent project —
    // and a member archiving or moving a colleague's shared project, which
    // assertProjectMutable refuses as project_not_found — both answered 500
    // "An unexpected error occurred". `project_not_found` was previously
    // asserted to be a SERVER fault here; it never was one. It is the refusal
    // the guard is built to give, deliberately shaped as "not found" so a
    // refusal cannot confirm that somebody else's project exists.
    assert.strictEqual(clientErrorStatus(err('archive_parent_with_children')), 409);
    assert.strictEqual(clientErrorStatus(err('project_not_found')), 404);
    assert.strictEqual(clientErrorStatus(err('project_cannot_parent_itself')), 400);
  });

  await t.test('lets an explicit status win over the registry', () => {
    assert.strictEqual(clientErrorStatus(err('duplicate_project_name', { publicMessage: 'x', status: 418 })), 418);
    // A 5xx override is not a client error and must not suppress the 500 path.
    assert.strictEqual(clientErrorStatus(err('duplicate_project_name', { publicMessage: 'x', status: 503 })), 409);
  });

  await t.test('does NOT classify real server faults as client errors', () => {
    // This is the guard that keeps genuine bugs reaching PostHog Error Tracking.
    assert.strictEqual(clientErrorStatus(err('connection terminated unexpectedly')), null);
    assert.strictEqual(clientErrorStatus(err('Cannot read properties of undefined (reading \'slice\')')), null);
    assert.strictEqual(clientErrorStatus(null), null);
    assert.strictEqual(clientErrorStatus(err('anything', { publicMessage: '' })), null);
  });
});

test('clientErrorBody carries recovery hints', () => {
  const body = clientErrorBody(
    err('duplicate_project_name', { publicMessage: 'already exists', existing_project_id: 'project_1' }),
    'req-abc'
  );
  assert.deepStrictEqual(body, {
    error: 'duplicate_project_name',
    message: 'already exists',
    existing_project_id: 'project_1',
    request_id: 'req-abc',
  });

  const bare = clientErrorBody(err('subproject_depth_exceeded'), 'req-def');
  assert.strictEqual(bare.error, 'subproject_depth_exceeded');
  assert.ok(!('message' in bare), 'a bare code should not invent a message');
});


test('the bare structural refusals carry a sentence the caller can act on', () => {
  // The exception to "a bare code invents no message": these three are thrown
  // from a service with no publicMessage, and "archive_parent_with_children" on
  // its own tells a dashboard user nothing they can do.
  assert.strictEqual(
    clientErrorBody(err('archive_parent_with_children')).message,
    'This project still has subprojects. Archive or move them first.'
  );
  assert.match(clientErrorBody(err('project_not_found')).message, /not yours to change/);
  // A publicMessage at the throw site still wins over the table.
  assert.strictEqual(
    clientErrorBody(err('project_not_found', { publicMessage: 'gone since Tuesday' })).message,
    'gone since Tuesday'
  );
  // And an unlisted bare code is still answered with a code alone.
  assert.ok(!('message' in clientErrorBody(err('low_value_workspace_entity'))));
});
