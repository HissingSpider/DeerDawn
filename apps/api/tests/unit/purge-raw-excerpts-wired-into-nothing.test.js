/**
 * scripts/purge-raw-excerpts.js IS RUN BY THE OWNER, BY HAND, AND BY NOTHING ELSE.
 *
 * It permanently replaces stored conversation excerpts in production. The owner
 * decided that removal is his to review and to run (docs/runbooks/
 * purge-raw-excerpts.md): after reading the dry run, at a time he chooses, with
 * a backup he knows about. Wired into a boot, a deploy, a schedule, CI or an npm
 * lifecycle script, it would run on the next release with nobody watching — the
 * one thing that decision ruled out. A boot may ADD the nullable column the
 * script reads (config/autoMigrate.js does); it may never remove anyone's data.
 *
 * This guard fails if anything that runs without a person typing the command
 * mentions the script: every package.json's scripts (lifecycle hooks included),
 * the container's start script and Dockerfile, fly.toml, the Makefile, every CI
 * workflow, every shell script and infra file, and the API's source (comments
 * aside — the reason it must not be called is written down beside the code). And
 * at runtime: loading the app, the boot migration and the scheduler loads no
 * part of it.
 *
 * Run: node --test tests/unit/purge-raw-excerpts-wired-into-nothing.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const API = path.join(REPO, 'apps', 'api');
const SCRIPT = path.join(API, 'scripts', 'purge-raw-excerpts.js');
const NAME = 'purge-raw-excerpts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'test-results', '.turbo']);

function walk(dir, keep, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

// Comment-blind, for the same reason as the marketing claims guards: the files
// most likely to mention the script are the ones explaining why it must not be
// called from there.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (file) => path.relative(REPO, file);

test('premise: the script exists, where the runbook says', () => {
  assert.ok(fs.existsSync(SCRIPT), `${rel(SCRIPT)} is missing`);
  const runbook = path.join(REPO, 'docs', 'runbooks', 'purge-raw-excerpts.md');
  assert.ok(fs.existsSync(runbook), `${rel(runbook)} is missing`);
});

test('no package.json script runs it — lifecycle hooks included', () => {
  const manifests = walk(REPO, (file) => path.basename(file) === 'package.json');
  assert.ok(manifests.length >= 5, `premise: the workspace's manifests were found (${manifests.length})`);
  const offenders = [];
  for (const file of manifests) {
    const scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {};
    for (const [name, command] of Object.entries(scripts)) {
      if (String(command).includes(NAME)) offenders.push(`${rel(file)} scripts.${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('nothing that runs at boot, at deploy, on a schedule or in CI names it', () => {
  const files = [
    path.join(API, 'scripts', 'start.sh'),
    path.join(API, 'Dockerfile'),
    path.join(API, 'fly.toml'),
    path.join(REPO, 'Makefile'),
    ...walk(path.join(REPO, '.github'), () => true),
    ...walk(path.join(REPO, 'infra'), () => true),
    ...walk(REPO, (file) => /\.(sh|bash|toml|ya?ml)$/.test(file) || /(^|\/)(Dockerfile[^/]*|Procfile)$/.test(file)),
  ];
  const seen = new Set();
  const offenders = [];
  for (const file of files) {
    if (seen.has(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    seen.add(file);
    if (fs.readFileSync(file, 'utf8').includes(NAME)) offenders.push(rel(file));
  }
  assert.ok(seen.has(path.join(API, 'scripts', 'start.sh')), 'premise: the container start script was read');
  assert.ok([...seen].some((file) => file.includes(`${path.sep}.github${path.sep}workflows${path.sep}`)), 'premise: the CI workflows were read');
  assert.deepEqual(offenders, []);
});

test('the API source calls it nowhere (comments aside), and no other script does', () => {
  const sources = [
    ...walk(path.join(API, 'src'), (file) => /\.(c|m)?js$/.test(file)),
    ...walk(path.join(API, 'scripts'), (file) => /\.(c|m)?js$/.test(file) && file !== SCRIPT),
  ];
  assert.ok(sources.length > 50, 'premise: the source tree was read');
  const offenders = sources.filter((file) => stripComments(fs.readFileSync(file, 'utf8')).includes(NAME)).map(rel);
  assert.deepEqual(offenders, []);
});

test('loading the app, the boot migration and the scheduler loads no part of it', () => {
  require('../../src/config/autoMigrate');
  require('../../src/jobs/scheduler');
  require('../../src/app');
  const loaded = Object.keys(require.cache);
  assert.ok(loaded.some((file) => file.endsWith(path.join('src', 'config', 'autoMigrate.js'))), 'premise: the boot migration was loaded');
  assert.deepEqual(loaded.filter((file) => file === SCRIPT), [], 'the running API does not load it');
});
