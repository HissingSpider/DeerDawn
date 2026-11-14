import { defineConfig } from 'tsup';
import { createRequire } from 'module';

// tsup's bundled rollup-plugin-dts injects `baseUrl: "."` into the DTS
// compile, which TypeScript 6 rejects as deprecated (TS5101) unless
// ignoreDeprecations is "6.0" — a value TypeScript 5.x rejects outright
// (TS5103). Which compiler the DTS build gets depends on npm hoisting:
// it resolves `typescript` from tsup's own install location, which the
// lockfile may place beside this package's TS 6 or at the root beside
// TS 5. So resolve it the same way tsup will, and pass the flag only to
// a compiler that needs and accepts it.
const requireFromTsup = createRequire(
  createRequire(import.meta.url).resolve('tsup/package.json')
);
const tsMajor = Number(
  requireFromTsup('typescript/package.json').version.split('.')[0]
);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: tsMajor >= 6 ? { ignoreDeprecations: '6.0' } : {},
  },
  clean: true,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "module";\nconst require = createRequire(import.meta.url);',
  },
});
