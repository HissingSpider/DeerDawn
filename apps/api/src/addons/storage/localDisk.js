'use strict';

// Local-disk storage for self-hosted installs (and dev/test). Keys are built by
// the platform from its own ids, never from user input, and are checked again
// here so a malformed key can never address a file outside the root.

const fs = require('fs/promises');
const path = require('path');

const KEY_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function createLocalDiskStorage(root) {
  const base = path.resolve(root);

  function fileFor(key) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.split('/').some((p) => p === '.' || p === '..')) {
      throw new Error(`invalid storage key: ${key}`);
    }
    const full = path.resolve(base, key);
    if (!full.startsWith(base + path.sep)) throw new Error(`storage key escapes the root: ${key}`);
    return full;
  }

  return {
    kind: 'local',
    root: base,
    async put(key, buffer) {
      const file = fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, buffer, { mode: 0o600 });
      await fs.rename(tmp, file);
    },
    async get(key) {
      try {
        return await fs.readFile(fileFor(key));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async delete(key) {
      try {
        await fs.unlink(fileFor(key));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },
  };
}

module.exports = { createLocalDiskStorage };
