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

const mod = loadTsModule(path.join(__dirname, '..', 'src', 'config.ts'));

test('accepts localhost development config with dev-key', () => {
  process.env.DEERDAWN_API_URL = 'http://localhost:8080';
  process.env.DEERDAWN_API_KEY = 'dev-key';
  process.env.DEERDAWN_ENVIRONMENT = 'production';

  const config = mod.loadConfig();
  assert.strictEqual(config.apiUrl, 'http://localhost:8080');
  assert.strictEqual(config.apiKey, 'dev-key');
});

test('rejects non-local config without dd_ prefix', () => {
  process.env.DEERDAWN_API_URL = 'https://api.deerdawn.com';
  process.env.DEERDAWN_API_KEY = 'dev-key';
  process.env.DEERDAWN_ENVIRONMENT = 'production';

  assert.throws(() => mod.loadConfig(), /Configuration validation failed/);
});

// config.ts validated the TRIMMED key but stored the raw one, so a key pasted
// with a trailing newline passed validation and then crashed the server at boot
// when the control character reached the x-api-key header.
test('stores the trimmed API key, not the raw padded one', () => {
  process.env.DEERDAWN_API_URL = 'https://api.deerdawn.com';
  process.env.DEERDAWN_API_KEY = '  dd_padded_key_1234567890\n';
  process.env.DEERDAWN_ENVIRONMENT = 'production';

  const config = mod.loadConfig();
  assert.strictEqual(config.apiKey, 'dd_padded_key_1234567890');
});

test('treats a whitespace-only API key as absent so the device flow runs', () => {
  process.env.DEERDAWN_API_URL = 'https://api.deerdawn.com';
  process.env.DEERDAWN_API_KEY = '  \n';
  process.env.DEERDAWN_ENVIRONMENT = 'production';

  const config = mod.loadConfig();
  assert.strictEqual(config.apiKey, undefined);
});
