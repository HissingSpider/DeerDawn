const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

const api = read('src/lib/api.ts');
const switcher = read('src/components/dashboard/brief/ProjectSwitcher.tsx');

test('api client exposes the nested project tree endpoint and type', () => {
  assert(api.includes('getContextProjectsTree'), 'api missing getContextProjectsTree');
  assert(api.includes('/api/v1/context/projects/tree'), 'api missing /projects/tree endpoint');
  assert(api.includes('subprojects?: ContextProjectSummary[]'), 'ContextProjectSummary missing subprojects field');
});

test('ProjectSwitcher flattens the tree and indents subprojects', () => {
  assert(switcher.includes('flattenProjectTree'), 'ProjectSwitcher missing tree flattening');
  assert(switcher.includes('subprojects'), 'ProjectSwitcher does not read subprojects');
  assert(/pl-7/.test(switcher), 'ProjectSwitcher missing subproject indentation');
});

// The redesign split BriefWorkspace into focused modules: the tree fetch (and
// its flat-list fallback) moved to useProjectContext, and the flattening that
// feeds selection moved to ProjectSwitcher. Same contract, two files.
test('the brief loads the project tree and flattens it for selection', () => {
  const projectContext = read('src/components/dashboard/brief/useProjectContext.ts');
  const switcher = read('src/components/dashboard/brief/ProjectSwitcher.tsx');

  assert(projectContext.includes('getContextProjectsTree'), 'brief is not fetching the project tree');
  // Graceful fallback to the flat list on an older API.
  assert(projectContext.includes('getContextProjects()'), 'brief is missing the flat-list fallback');
  assert(switcher.includes('subprojects ?? []'), 'project switcher is not flattening subprojects for selection');
});

if (process.exitCode) {
  console.error('\nSubproject tree UI regressions detected.');
} else {
  console.log('\nSubproject tree UI contracts in place.');
}
