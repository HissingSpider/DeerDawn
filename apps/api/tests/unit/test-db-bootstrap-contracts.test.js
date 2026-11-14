const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const apiRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(apiRoot, relativePath), 'utf8');
}

test('API test tooling provides a dedicated DB bootstrap and wrapper scripts', () => {
  const bootstrapPath = path.join(apiRoot, 'scripts', 'bootstrap-test-db.sh');
  const wrapperPath = path.join(apiRoot, 'scripts', 'run-db-test.sh');

  assert.ok(fs.existsSync(bootstrapPath), 'expected scripts/bootstrap-test-db.sh');
  assert.ok(fs.existsSync(wrapperPath), 'expected scripts/run-db-test.sh');

  const bootstrap = read('scripts/bootstrap-test-db.sh');
  const wrapper = read('scripts/run-db-test.sh');

  assert.match(bootstrap, /docker compose -f .*docker-compose\.yml.*up -d postgres/);
  assert.match(bootstrap, /npm run migrate/);
  assert.match(bootstrap, /DATABASE_URL/);
  assert.match(wrapper, /bootstrap-test-db\.sh/);
  assert.match(wrapper, /exec "\$@"/);
});

test('package scripts route DB-backed test commands through the shared DB wrapper', () => {
  const pkg = JSON.parse(read('package.json'));
  const dbBackedScripts = [
    'test',
    'test:integration:db',
    'test:e2e',
    'test:layer0',
    'test:layer1',
    'test:layer2',
    'test:layer3',
    'test:layer4',
    'test:layer6',
    'test:layer7',
    'test:layer8',
    'test:layer9',
    'test:layer10',
    'test:layers',
  ];

  for (const scriptName of dbBackedScripts) {
    assert.match(
      pkg.scripts[scriptName] || '',
      /bash scripts\/run-db-test\.sh/,
      `expected ${scriptName} to use scripts/run-db-test.sh`
    );
  }

  assert.match(
    pkg.scripts['test:integration:db'] || '',
    /signup-pricing\.test\.js/,
    'expected test:integration:db to cover DB-backed integration suites'
  );
});

test('layer runner bootstraps the DB once before executing suites', () => {
  const runner = read('tests/run-all-layers.sh');

  assert.match(runner, /bash scripts\/bootstrap-test-db\.sh/);
  assert.doesNotMatch(runner, /make up && make migrate/);
});
