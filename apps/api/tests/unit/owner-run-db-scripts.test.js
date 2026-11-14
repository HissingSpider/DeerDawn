/**
 * apps/api/scripts/owner-run/*.sql ARE RUN BY THE OWNER, BY HAND, AND BY NOTHING ELSE.
 *
 * Round 6, the owner's decision: the index migration is prepared for him to run
 * (CREATE INDEX CONCURRENTLY, so no table lock), and the two counts are
 * read-only. This guard pins the properties the runbook
 * (docs/runbooks/owner-run-db-checks.md) promises:
 *
 *   - 01: every statement is CREATE INDEX CONCURRENTLY IF NOT EXISTS, none sits
 *     in a transaction block (CONCURRENTLY cannot), and each has a comment above
 *     it that says which query it serves.
 *   - 02, 03 and 04: a READ ONLY transaction, rolled back, and no statement that
 *     writes.
 *   - nothing that runs without a person typing the command names the folder:
 *     package.json scripts, the container's start script, Dockerfile, fly.toml,
 *     the Makefile, CI workflows, the API source, the boot migration.
 *
 * Run: node --test tests/unit/owner-run-db-scripts.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const API = path.join(REPO, 'apps', 'api');
const DIR = path.join(API, 'scripts', 'owner-run');
const NAME = 'owner-run';
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'test-results', '.turbo']);

const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const stripSqlComments = (sql) => sql.replace(/--.*$/gm, '');
const statements = (sql) => stripSqlComments(sql).split(';').map((s) => s.trim()).filter(Boolean);

function walk(dir, keep, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

test('premise: the four scripts and the runbook exist', () => {
  for (const file of ['01-graph-delete-indexes.sql', '02-count-cross-account-rows.sql', '03-count-lifetime-accounts.sql', '04-count-empty-team-workspaces.sql']) {
    assert.ok(fs.existsSync(path.join(DIR, file)), `${file} is missing`);
  }
  assert.ok(fs.existsSync(path.join(REPO, 'docs', 'runbooks', 'owner-run-db-checks.md')));
});

test('01: every statement is CREATE INDEX CONCURRENTLY IF NOT EXISTS, outside any transaction, each with a comment saying what it serves', () => {
  const sql = read('01-graph-delete-indexes.sql');
  const all = statements(sql);
  assert.equal(all.length, 4, 'four indexes');
  for (const statement of all) {
    assert.match(statement, /^CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_context_graph_\w+\s+ON context_graph_(nodes|edges|evidence) \(/, statement);
  }
  assert.doesNotMatch(stripSqlComments(sql), /\b(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i, 'CONCURRENTLY cannot run inside a transaction');
  assert.doesNotMatch(stripSqlComments(sql), /\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE)\b/i, 'it only creates indexes');
  // The comment block directly above each statement names the query it serves.
  const lines = sql.split('\n');
  lines.forEach((line, i) => {
    if (!line.startsWith('CREATE INDEX CONCURRENTLY')) return;
    let j = i - 1;
    const comment = [];
    while (j >= 0 && lines[j].startsWith('--')) comment.unshift(lines[j--]);
    assert.match(comment.join(' '), /Serves:/, `no "Serves:" comment above: ${line}`);
  });
});

test('01: it creates the indexes the boot path does not, and the boot path never creates them', () => {
  const names = statements(read('01-graph-delete-indexes.sql')).map((s) => /IF NOT EXISTS (\w+)/.exec(s)[1]);
  assert.equal(new Set(names).size, 4);
  const sources = [
    ...walk(path.join(API, 'src'), (file) => /\.(c|m)?js$/.test(file)),
    ...walk(path.join(API, 'scripts'), (file) => /\.(c|m)?js$/.test(file)),
  ];
  assert.ok(sources.length > 50, 'premise: the source tree was read');
  const offenders = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of names) if (text.includes(name)) offenders.push(`${path.relative(REPO, file)} names ${name}`);
  }
  assert.deepEqual(offenders, [], 'these indexes are the owner\'s to build; a boot that also built them would take the table lock this file avoids');
});

for (const file of ['02-count-cross-account-rows.sql', '03-count-lifetime-accounts.sql', '04-count-empty-team-workspaces.sql']) {
  test(`${file}: a READ ONLY transaction, rolled back, with no statement that writes`, () => {
    const code = stripSqlComments(read(file));
    assert.match(code.trim(), /^BEGIN READ ONLY;/i);
    assert.match(code.trim(), /ROLLBACK;$/i);
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|LOCK|COMMIT)\b/i, 'no write, no DDL, no explicit lock');
    for (const statement of statements(code)) {
      assert.match(statement, /^(BEGIN READ ONLY|SET LOCAL statement_timeout|SELECT|WITH|ROLLBACK)\b/i, statement.slice(0, 60));
    }
  });
}

test('nothing that runs without a person typing the command names the folder', () => {
  const manifests = walk(REPO, (file) => path.basename(file) === 'package.json');
  assert.ok(manifests.length >= 5, 'premise: the manifests were found');
  const offenders = [];
  for (const file of manifests) {
    for (const [name, command] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {})) {
      if (String(command).includes(NAME)) offenders.push(`${path.relative(REPO, file)} scripts.${name}`);
    }
  }
  const files = [
    path.join(API, 'scripts', 'start.sh'),
    path.join(API, 'Dockerfile'),
    path.join(API, 'fly.toml'),
    path.join(REPO, 'Makefile'),
    ...walk(path.join(REPO, '.github'), () => true),
    ...walk(path.join(REPO, 'infra'), () => true),
    ...walk(REPO, (file) => /\.(sh|bash|toml|ya?ml)$/.test(file) || /(^|\/)(Dockerfile[^/]*|Procfile)$/.test(file)),
    ...walk(path.join(API, 'src'), (file) => /\.(c|m)?js$/.test(file)),
    ...walk(path.join(API, 'scripts'), (file) => /\.(c|m)?js$/.test(file)),
  ];
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    seen.add(file);
    // A shell script that lives in the folder itself is not a caller.
    if (file.startsWith(DIR)) continue;
    if (fs.readFileSync(file, 'utf8').includes(`scripts/${NAME}`)) offenders.push(path.relative(REPO, file));
  }
  assert.ok(seen.has(path.join(API, 'scripts', 'start.sh')), 'premise: the container start script was read');
  assert.deepEqual(offenders, []);
});

test('04: it counts only workspaces with no user, project, payment or billing history, and lists ids without emails', () => {
  const code = stripSqlComments(read('04-count-empty-team-workspaces.sql'));
  for (const condition of [
    /NOT EXISTS \(SELECT 1 FROM users u WHERE u\.org_id = o\.org_id\)/,
    /FROM workspace_members m WHERE m\.owner_key = o\.org_id\) = 1/,
    /NOT EXISTS \(SELECT 1 FROM context_projects p WHERE p\.owner_key = o\.org_id\)/,
    /stripe_customer_id IS NULL/,
    /stripe_subscription_id IS NULL/,
    /NOT EXISTS \(SELECT 1 FROM subscription_events e WHERE e\.org_id = o\.org_id\)/,
  ]) {
    assert.match(code, condition);
  }
  assert.doesNotMatch(code, /\bemail\b/i, 'no email is read');
});
