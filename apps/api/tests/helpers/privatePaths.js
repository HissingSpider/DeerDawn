'use strict';

// Paths that exist only in the private repository. The public export
// (scripts/open-source/export.sh) does not ship apps/marketing, apps/video,
// e2e/journey, internal docs or the agent instruction files, so a contract
// test that reads one of them skips in a public checkout, with this reason,
// and still runs in the private repo.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * A skip reason naming the repo-relative paths that are missing, or null when
 * every one is present (the private repo).
 */
function privateSkipReason(...relativePaths) {
  const missing = relativePaths.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
  if (missing.length === 0) return null;
  return `${missing.join(', ')} not in this checkout (private repo only; the public export does not ship it)`;
}

module.exports = { REPO_ROOT, privateSkipReason };
