const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const routeSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/routes/context/context-sync.js'),
  'utf8'
);
const serviceSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/services/contextSyncService.js'),
  'utf8'
);

test('context sync route exposes structured event ingestion', () => {
  assert(routeSource.includes('router.post(\'/events\''), 'missing /events route');
  assert(routeSource.includes('ContextEventIngestSchema'), 'missing structured event schema');
});

test('context sync service exposes structured event application', () => {
  assert(serviceSource.includes('async function applyStructuredContextEvent'), 'missing applyStructuredContextEvent');
  assert(serviceSource.includes('applyStructuredContextEvent,'), 'missing structured event export');
});
