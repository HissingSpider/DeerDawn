const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...relativePath.split('/')), 'utf8');
}

test('desktop auth handoff uses one-time code exchange instead of returning a raw API key to the browser', () => {
    const authRoute = read('routes/shared/auth.js');

    assert.match(authRoute, /router\.post\('\/desktop\/start'/);
    assert.match(authRoute, /router\.get\('\/desktop\/exchange'/);
    assert.match(authRoute, /desktop_auth:\$\{handoffCode\}/);
    assert.match(authRoute, /handoff_code:\s*handoffCode/);
    assert.doesNotMatch(authRoute, /res\.json\(\{\s*key:/);
    assert.match(authRoute, /res\.json\(\{\s*api_key:\s*parsed\.api_key,\s*email:/);
});
