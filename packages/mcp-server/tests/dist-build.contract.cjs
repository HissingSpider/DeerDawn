'use strict';

// Guards against shipping a broken bundle (e.g. undefined isContextFresh in 1.0.16).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const distPath = path.join(__dirname, '..', 'dist', 'index.js');
const source = fs.readFileSync(distPath, 'utf8');

assert.ok(
  !source.includes('isContextFresh'),
  'dist/index.js must not reference undefined isContextFresh — use hasFreshContext'
);
assert.ok(
  source.includes('hasFreshContext'),
  'dist/index.js must use hasFreshContext in start_session'
);

console.log('✓ dist build contract (start_session freshness guard)');
