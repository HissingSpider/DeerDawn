const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('./helpers/privatePaths');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath) {
    return fs.existsSync(path.join(repoRoot, relativePath));
}

// `requires`: repo paths only the private repo has; reported as skipped where
// they are missing (the public export does not ship apps/marketing).
function test(name, fn, { requires = [] } = {}) {
    const skip = privateSkipReason(...requires);
    if (skip) {
        console.log(`- ${name} (skipped: ${skip})`);
        return;
    }
    try {
        fn();
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
        process.exitCode = 1;
    }
}

console.log('=== Growth Content Contract Tests ===\n');

test('API exposes admin and public content route modules', () => {
    assert(exists('apps/api/src/routes/admin-content.js'), 'admin content route is missing');
    assert(exists('apps/api/src/routes/public-content.js'), 'public content route is missing');
    const app = read('apps/api/src/app.js');
    assert(app.includes('/api/v1/admin/content'), 'admin content route is not mounted');
    assert(app.includes('/api/v1/public/content'), 'public content route is not mounted');
});

test('database schema includes content, lead event, and tool submission tables', () => {
    const schema = read('apps/api/sql/schema.sql');
    for (const table of ['content_pages', 'content_versions', 'content_assets', 'lead_events', 'tool_submissions']) {
        assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} table is missing`);
    }
    assert(schema.includes('source_route'), 'lead source metadata is missing');
});

test('dashboard includes founder/admin content CMS route', () => {
    assert(exists('apps/dashboard/src/pages/admin/content.tsx'), 'dashboard content CMS page is missing');
    const api = read('apps/dashboard/src/lib/api.ts');
    assert(api.includes('listContentPages'), 'dashboard API client cannot list content pages');
    assert(api.includes('saveContentPage'), 'dashboard API client cannot save content pages');
});

test('marketing exposes organic growth routes and tool surfaces', () => {
    for (const routeFile of [
        'apps/marketing/src/pages/use-cases/[slug].tsx',
        'apps/marketing/src/pages/compare/[slug].tsx',
        'apps/marketing/src/pages/blog/index.tsx',
        'apps/marketing/src/pages/blog/[slug].tsx',
        'apps/marketing/src/pages/examples.tsx',
        'apps/marketing/src/pages/tools/roi-calculator.tsx',
    ]) {
        assert(exists(routeFile), `${routeFile} is missing`);
    }
}, { requires: ['apps/marketing'] });

test('LLM discovery and sitemap include growth surfaces', () => {
    assert(exists('apps/marketing/src/pages/deerdawn-llm.txt.ts'), 'deerdawn-llm.txt route is missing');
    const sitemap = read('apps/marketing/src/pages/sitemap.xml.tsx');
    for (const route of ['/use-cases/', '/compare/', '/blog', '/examples', '/tools/roi-calculator']) {
        assert(sitemap.includes(route), `sitemap does not include ${route}`);
    }
}, { requires: ['apps/marketing'] });

if (process.exitCode) {
    console.error('\nGrowth content contracts failed.');
} else {
    console.log('\nGrowth content contracts in place.');
}
