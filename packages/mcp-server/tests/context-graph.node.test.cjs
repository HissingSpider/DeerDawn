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

const mod = loadTsModule(path.join(__dirname, '..', 'src', 'tools', 'index.ts'));

test('advertises graph inspection through the grouped recall tool', () => {
  const tools = mod.listTools();
  const recall = tools.find((tool) => tool.name === 'recall');
  assert.ok(recall);
  assert.ok(recall.inputSchema.properties.action.enum.includes('map'));
  assert.ok(!tools.find((tool) => tool.name === 'inspect_context_graph'));
});

test('registers smart context MCP tools for setup and relevance guidance', () => {
  const tools = mod.listTools();
  assert.ok(tools.find((tool) => tool.name === 'get_setup_status'));
  assert.ok(tools.find((tool) => tool.name === 'apply_setup'));
  const recall = tools.find((tool) => tool.name === 'recall');
  assert.ok(recall.inputSchema.properties.action.enum.includes('next'));
  assert.ok(!tools.find((tool) => tool.name === 'get_next_best_context'));
});
