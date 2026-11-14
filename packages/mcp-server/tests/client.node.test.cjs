const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// servers it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

function loadTsModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;

  const module = { exports: {} };
  const dirname = path.dirname(filePath);
  const customRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(dirname, specifier);
      if (resolved.endsWith('.js') && fs.existsSync(resolved.replace(/\.js$/, '.ts'))) {
        return loadTsModule(resolved.replace(/\.js$/, '.ts'));
      }
      if (resolved.endsWith('.ts') || resolved.endsWith('.js')) return require(resolved);
      if (fs.existsSync(`${resolved}.js`)) return require(`${resolved}.js`);
      if (fs.existsSync(`${resolved}.ts`)) return loadTsModule(`${resolved}.ts`);
      return require(resolved);
    }
    return require(specifier);
  };

  const context = vm.createContext({
    module,
    exports: module.exports,
    require: customRequire,
    __dirname: dirname,
    __filename: filePath,
    process,
    console,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(transpiled, context, { filename: filePath });
  return module.exports;
}

const { DeerdawnClient } = loadTsModule(path.join(__dirname, '..', 'src', 'client.ts'));

test('accepts localhost development client config with dev-key', () => {
  const client = new DeerdawnClient({
    apiUrl: 'http://localhost:8080',
    apiKey: 'dev-key',
    environment: 'production',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 0,
    retryBackoffMs: 100,
  });

  assert.ok(client);
});

test('rejects non-local client config without dd_ prefix', () => {
  assert.throws(() => new DeerdawnClient({
    apiUrl: 'https://api.deerdawn.com',
    apiKey: 'dev-key',
    environment: 'production',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 0,
    retryBackoffMs: 100,
  }), /must start with dd_/);
});
