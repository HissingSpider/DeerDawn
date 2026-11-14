'use strict';

/**
 * A team workspace as it exists the moment its Team subscription is confirmed
 * (journey r6: a workspace is created at checkout, so POST /teams/workspaces no
 * longer creates one). Tests that need "a second workspace this person owns, on
 * Free, with nobody else in it" build it here, through the same function the
 * Stripe webhook uses (workspaceService.createTeamWorkspaceAtCheckout), and get
 * back the shape the old route answered, so the assertions around it stand.
 */

const crypto = require('node:crypto');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');

async function createTeamWorkspaceFixture(person, name) {
  const orgId = `org-${crypto.randomUUID()}`;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await workspace.createTeamWorkspaceAtCheckout(client, { orgId, name, founderUserId: person.userId });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { status: 201, body: { workspace: orgId, name, role: 'owner', plan_tier: 'free', upgrade_required: true } };
}

module.exports = { createTeamWorkspaceFixture };
