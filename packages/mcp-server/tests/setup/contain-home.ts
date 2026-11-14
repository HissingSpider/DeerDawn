import { createRequire } from 'node:module';
import { afterAll } from 'vitest';

// Runs before every test file (vitest setupFiles): clears the home-like
// variables the code honours, gives the file a HOME of its own, and fails the
// file if it wrote under the developer's CODEX_HOME. See
// packages/shared-context/tests/contain-home.cjs for why and what.
const require = createRequire(import.meta.url);
const { containTestProcess } = require('../../../shared-context/tests/contain-home.cjs');

containTestProcess(afterAll);
