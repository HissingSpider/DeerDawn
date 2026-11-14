'use strict';

// The loaded add-ons, once per process. Loaded lazily on first use (and
// eagerly from server.js at boot, so a bad add-on is logged at start-up rather
// than on the first request that touches the registry).

const { loadAddons } = require('./loader');

let state = null;

function load(options) {
  state = loadAddons(options);
  return state;
}

function current() {
  return state || load();
}

/** @returns {object|null} */
function getAddon(id) {
  if (typeof id !== 'string') return null;
  return current().addons.get(id) || null;
}

function listAddons() {
  return [...current().addons.values()];
}

function skippedAddons() {
  return current().skipped.slice();
}

/** Tests: replace the registry (pass options to loadAddons), or reset to lazy. */
function reloadForTests(options) {
  if (options === undefined) { state = null; return null; }
  return load(options);
}

module.exports = { getAddon, listAddons, skippedAddons, load, reloadForTests };
