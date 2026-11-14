'use strict';

// READS addons/*/addon.json AT BOOT.
//
// Each add-on is validated on its own and a bad one is SKIPPED AND LOGGED,
// never thrown: one broken manifest (or a server add-on whose index.js throws
// on require) must not stop the API booting for everybody else. The loader
// returns what it loaded and what it skipped, with the reason, so the boot log
// and the tests can both see it.
//
// DEERDAWN_ADDONS is an allowlist: a comma-separated list of add-on ids. Unset
// or empty means every add-on in the directory (compose files spell "unset" as
// an empty string). `none` loads nothing.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { validateManifest, validateActions, GENERIC_ACTIONS } = require('../../../../packages/addon-kit/src');
const { genericActions } = require('./genericActions');

const DEFAULT_ADDONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'addons');

function addonsDir(env = process.env) {
  const configured = typeof env.ADDONS_DIR === 'string' ? env.ADDONS_DIR.trim() : '';
  return configured ? path.resolve(configured) : DEFAULT_ADDONS_DIR;
}

function parseAllowlist(env = process.env) {
  const raw = typeof env.DEERDAWN_ADDONS === 'string' ? env.DEERDAWN_ADDONS.trim() : '';
  if (!raw) return null; // everything
  if (raw.toLowerCase() === 'none') return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function newAjv() {
  // strict:false so an author's schema with an unknown keyword (a "title" on a
  // property, a draft-2019 annotation) is not a load failure.
  return new Ajv({ allErrors: true, strict: false, useDefaults: false });
}

/** Resolve a manifest-relative path, refusing anything that escapes the add-on dir. */
function resolveInside(dir, relative) {
  const full = path.resolve(dir, relative);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`path "${relative}" escapes the add-on directory`);
  return full;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function formatAjvErrors(errors) {
  return (errors || []).slice(0, 5).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

/**
 * Load one add-on directory. Throws with a readable reason on any problem;
 * loadAddons turns that into a skip.
 */
function loadAddon(dir, { ajv = newAjv() } = {}) {
  const manifestPath = path.join(dir, 'addon.json');
  if (!fs.existsSync(manifestPath)) throw new Error('no addon.json');
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    throw new Error(`addon.json is not valid JSON: ${err.message}`);
  }
  const verdict = validateManifest(manifest);
  if (!verdict.ok) throw new Error(`invalid manifest: ${verdict.errors.join('; ')}`);
  if (path.basename(dir) !== manifest.id) throw new Error(`directory name "${path.basename(dir)}" must equal the manifest id "${manifest.id}"`);

  const collections = {};
  for (const [name, def] of Object.entries(manifest.collections)) {
    let schema;
    try {
      schema = readJson(resolveInside(dir, def.schema));
    } catch (err) {
      throw new Error(`collection "${name}": cannot read schema ${def.schema}: ${err.message}`);
    }
    if (!schema || typeof schema !== 'object' || (schema.type && schema.type !== 'object')) {
      throw new Error(`collection "${name}": schema must describe an object`);
    }
    let validate;
    try {
      const { $id: _ignoredId, ...rest } = schema; // two add-ons may reuse an $id; compile each on its own
      validate = ajv.compile(rest);
    } catch (err) {
      throw new Error(`collection "${name}": schema does not compile: ${err.message}`);
    }
    collections[name] = { name, attachments: def.attachments === true, schema, validate };
  }

  let skillText = '';
  if (manifest.skill) {
    try {
      skillText = fs.readFileSync(resolveInside(dir, manifest.skill), 'utf8');
    } catch (err) {
      throw new Error(`cannot read skill ${manifest.skill}: ${err.message}`);
    }
  }

  let actionDefs;
  const indexPath = path.join(dir, 'index.js');
  if (manifest.kind === 'server') {
    if (!fs.existsSync(indexPath)) throw new Error('kind "server" requires an index.js');
    let mod;
    try {
      mod = require(indexPath);
    } catch (err) {
      throw new Error(`index.js failed to load: ${err.message}`);
    }
    const checked = validateActions(mod && mod.actions);
    if (!checked.ok) throw new Error(`index.js: ${checked.errors.join('; ')}`);
    actionDefs = mod.actions;
  } else {
    if (fs.existsSync(indexPath)) throw new Error('a declarative add-on must not ship an index.js (set kind to "server")');
    actionDefs = genericActions(Object.keys(collections));
  }

  const actions = {};
  for (const [name, def] of Object.entries(actionDefs)) {
    const input = def.input || { type: 'object' };
    let validateInput;
    try {
      validateInput = ajv.compile(input);
    } catch (err) {
      throw new Error(`action "${name}": input schema does not compile: ${err.message}`);
    }
    actions[name] = {
      name,
      mode: def.mode,
      description: def.description,
      input,
      validateInput,
      handler: def.handler,
      generic: manifest.kind === 'declarative' && GENERIC_ACTIONS.includes(name),
    };
  }

  return {
    id: manifest.id,
    manifest,
    dir,
    kind: manifest.kind,
    skillText,
    collections,
    actions,
  };
}

/**
 * Load every allowed add-on under `dir`. Never throws.
 * @returns {{addons: Map<string, object>, skipped: {id: string, reason: string}[]}}
 */
function loadAddons({ dir = addonsDir(), env = process.env, log = console } = {}) {
  const addons = new Map();
  const skipped = [];
  const allow = parseAllowlist(env);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`[ADDONS] cannot read ${dir}: ${err.message}`);
    return { addons, skipped };
  }
  const ajv = newAjv();
  for (const name of entries) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    if (allow && !allow.has(name)) continue;
    try {
      const addon = loadAddon(path.join(dir, name), { ajv });
      addons.set(addon.id, addon);
    } catch (err) {
      skipped.push({ id: name, reason: err.message });
      log.warn(`[ADDONS] skipped "${name}": ${err.message}`);
    }
  }
  if (addons.size) log.log(`[ADDONS] loaded ${[...addons.keys()].join(', ')}`);
  return { addons, skipped };
}

module.exports = { loadAddons, loadAddon, addonsDir, parseAllowlist, formatAjvErrors, DEFAULT_ADDONS_DIR };
