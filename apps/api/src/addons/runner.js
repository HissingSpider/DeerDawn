'use strict';

// RUNS ONE ADD-ON ACTION. The single path every transport goes through: the
// HTTP route, the hosted MCP dispatcher (directly), and the local MCP server
// (over the HTTP route). Add-on logic therefore exists once.
//
// Order of checks, each with its own refusal:
//   1. the add-on exists                          404 addon_not_found
//   2. there is a PERSON behind the call          403 addon_person_required
//   3. `help` answers here, enabled or not
//   4. the action exists                          404 addon_action_not_found
//   5. a write through the read path              403 addon_write_via_read
//   6. the workspace has the add-on switched on   409 addon_disabled
//   7. a write needs context:write AND a role that writes in this workspace
//                                                 403 addon_read_only
//   8. args match the action's input schema       400 addon_bad_args
// then the handler runs with a ctx scoped to (workspace, add-on, person).
//
// The workspace is workspaceService.defaultOwnerKey(actor): the auth
// middleware has already bound and membership-checked it (and, for a lapsed
// team, decided whether this request falls back or is refused).

const workspace = require('../services/workspaceService');
const registry = require('./registry');
const enablement = require('./enablement');
const { buildContext } = require('./context');
const { AddonError, isAddonError } = require('./errors');
const { formatAjvErrors } = require('./loader');

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;
const MAX_TEXT = 100 * 1000;

function hasScope(actor, scope) {
  const scopes = Array.isArray(actor?.scopes) ? actor.scopes : [];
  if (actor?.type === 'system') return true;
  if (scopes.includes('*') || scopes.includes(scope)) return true;
  if (scope === 'context:read') return scopes.includes('context:write') || scopes.includes('context:admin');
  if (scope === 'context:write') return scopes.includes('context:admin');
  return false;
}

/** May this actor write in this workspace? Same rule as contextSyncService.actorMayWriteWorkspace. */
async function mayWrite(actor, ownerKey) {
  if (!hasScope(actor, 'context:write')) return false;
  const role = await workspace.resolveRole(actor, ownerKey);
  if (workspace.canWrite(role)) return true;
  return !(await workspace.isSharedWorkspace(ownerKey));
}

/** May this actor switch add-ons on or off for the workspace? Owners in a team; the person in a solo one. */
async function mayManage(actor, ownerKey) {
  if (!hasScope(actor, 'context:write')) return false;
  const role = await workspace.resolveRole(actor, ownerKey);
  if (workspace.canAdminister(role)) return true;
  if (await workspace.isSharedWorkspace(ownerKey)) return false;
  return workspace.canWrite(role);
}

function scopeFor(actor) {
  const ownerKey = workspace.defaultOwnerKey(actor);
  const personId = workspace.actorPersonId(actor);
  if (!ownerKey || !personId) {
    throw new AddonError(403, 'addon_person_required', 'Add-ons store data for a person, and this credential is not one (it has no person behind it).');
  }
  return { ownerKey, personId };
}

function describeAction(def) {
  return { name: def.name, mode: def.mode, description: def.description, input: def.input };
}

function helpResult(addon) {
  const actions = Object.values(addon.actions).map(describeAction);
  actions.unshift({ name: 'help', mode: 'read', description: 'This text: the add-on instructions and its actions.', input: { type: 'object' } });
  // The argument shapes go in the TEXT: over MCP `data` is left out unless the
  // caller asks for it, and help is useless without them.
  const shape = (input) => JSON.stringify({ properties: input?.properties || {}, required: input?.required || [] });
  const lines = actions.map((a) => `- ${a.name} (${a.mode === 'write' ? 'use_addon' : 'read_addon'}): ${a.description}\n  args: ${shape(a.input)}`);
  const text = [
    `# ${addon.manifest.name} (${addon.id} ${addon.manifest.version})`,
    addon.manifest.description || '',
    addon.skillText ? `\n${addon.skillText.trim()}` : '',
    '\n## Actions',
    ...lines,
    '\nAdd include_data: true to args for the structured result as well.',
  ].filter(Boolean).join('\n');
  return {
    text,
    data: {
      addon: addon.id,
      version: addon.manifest.version,
      collections: Object.values(addon.collections).map((c) => ({ name: c.name, attachments: c.attachments, schema: c.schema })),
      actions,
    },
    images: [],
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || typeof result.text !== 'string') {
    throw new AddonError(500, 'addon_bad_result', 'The add-on returned no text.');
  }
  const images = Array.isArray(result.images) ? result.images : [];
  if (images.length > MAX_IMAGES) throw new AddonError(500, 'addon_bad_result', `An action may return at most ${MAX_IMAGES} images.`);
  let total = 0;
  for (const image of images) {
    if (!image || typeof image.mime !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(image.mime) || typeof image.base64 !== 'string') {
      throw new AddonError(500, 'addon_bad_result', 'Each returned image needs an image mime type and base64 data.');
    }
    total += image.base64.length;
  }
  if (total > MAX_IMAGE_BASE64) throw new AddonError(500, 'addon_bad_result', 'The returned images are too large.');
  const data = result.data && typeof result.data === 'object' ? result.data : null;
  return {
    text: result.text.length > MAX_TEXT ? `${result.text.slice(0, MAX_TEXT)}\n[truncated]` : result.text,
    data,
    images: images.map((i) => ({ mime: i.mime, base64: i.base64 })),
  };
}

/**
 * @param {object} p
 * @param {object} p.actor
 * @param {string} p.addonId
 * @param {string} p.action
 * @param {object} [p.args]
 * @param {'read'|'write'} p.via   'read' refuses write actions (read_addon)
 * @param {'mcp-hosted'|'mcp-local'|'http'} [p.transport]
 * @param {object} [p.req]          for building absolute links
 * @returns {Promise<{text: string, data: object|null, images: object[]}>}
 */
async function runAddonAction({ actor, addonId, action, args = {}, via = 'write', transport = 'http', req = null }) {
  const addon = registry.getAddon(addonId);
  if (!addon) throw new AddonError(404, 'addon_not_found', `There is no add-on "${addonId}" on this server.`);
  const { ownerKey, personId } = scopeFor(actor);

  if (action === 'help') return helpResult(addon);

  const def = Object.prototype.hasOwnProperty.call(addon.actions, action) ? addon.actions[action] : null;
  if (!def) {
    throw new AddonError(404, 'addon_action_not_found', `${addon.manifest.name} has no action "${action}". Call help for the list.`);
  }
  if (via === 'read' && def.mode === 'write') {
    throw new AddonError(403, 'addon_write_via_read', `"${action}" changes data, so it runs through use_addon, not read_addon. Nothing was changed.`);
  }
  if (!(await enablement.isEnabled(ownerKey, addon.id))) {
    throw new AddonError(409, 'addon_disabled', `${addon.manifest.name} is not switched on for this workspace. Turn it on at /addons.`);
  }
  if (def.mode === 'write' && !(await mayWrite(actor, ownerKey))) {
    throw new AddonError(403, 'addon_read_only', 'You have read-only access to this workspace, so nothing was saved.');
  }

  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!def.validateInput(input)) {
    throw new AddonError(400, 'addon_bad_args', `Arguments for ${action} do not match its schema: ${formatAjvErrors(def.validateInput.errors)}. Call help for the shapes.`);
  }

  const ctx = buildContext({ addon, actor, ownerKey, personId, transport, mode: def.mode, req });
  let result;
  try {
    result = await def.handler(ctx, input);
  } catch (err) {
    if (isAddonError(err)) throw err;
    console.error(`[ADDONS] ${addon.id}.${action} failed:`, err);
    throw new AddonError(500, 'addon_action_failed', `${addon.manifest.name} could not complete "${action}".`);
  }
  return normalizeResult(result);
}

/**
 * MCP REPLIES CARRY TEXT, NOT TEXT AND DATA. `data` repeats what the text
 * says and roughly doubles the tokens of a large listing, so the two MCP
 * transports leave it out unless the caller passes `include_data: true` in
 * args, or the action returned no text. HTTP (the dashboard) always gets data.
 * `include_data` is removed from args before the action's schema sees it.
 */
function splitIncludeData(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const includeData = input.include_data === true;
  delete input.include_data;
  return { args: input, includeData };
}

function forMcp(result, includeData) {
  const keepData = Boolean(result.data) && (includeData || !result.text);
  return { text: result.text, data: keepData ? result.data : null, images: result.images };
}

module.exports = { splitIncludeData, forMcp, runAddonAction, mayWrite, mayManage, scopeFor, hasScope, helpResult };
