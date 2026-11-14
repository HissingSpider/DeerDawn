'use strict';

// JOURNEY R3, A1: THE SAME LISTING FROM BOTH DISPATCHERS, THROUGH THE REAL ROUTES.
//
// After the nightly job archived both of a person's projects, start_session said
// "2 archived projects are waiting, not gone ... call recall(action:"projects")
// for the IDs", and the listing it pointed to answered as if there were none:
// the hosted connector "No projects yet. Use manage_projects with action
// "create" to create one.", this server "[DeerDawn — 0 projects]" (its map
// fallback). An assistant that believed either created an empty project beside
// the archived one.
//
// mcp-dispatcher-parity.test.js pins, on source text, that both dispatchers
// render the listing with shared-context's formatProjectListing. This file pins
// the BEHAVIOUR: the BUILT stdio server, talking to the API's REAL
// context-sync router (GET /projects/tree and GET /projects?archived=1, their
// real handlers and serializers), and the hosted dispatcher (apps/api
// routes/mcp.js dispatchTool), both fed the same stored projects, must answer
// recall(action:"projects") with the same text, byte for byte, and that text
// must name the archived projects with their ids. Only what needs a database
// is replaced: the auth middleware, the rate limiter, and the two service reads
// behind those routes.
//
// Runs under `npm run test:node`, after the build.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// server it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);

const PKG = path.resolve(__dirname, '..');
const DIST = path.join(PKG, 'dist', 'index.js');
const API_SRC = path.resolve(PKG, '..', '..', 'apps', 'api', 'src');
const { Client } = require(require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: [PKG] }));
const { StdioClientTransport } = require(require.resolve('@modelcontextprotocol/sdk/client/stdio.js', { paths: [PKG] }));

// ── The API, with only its database-bound collaborators replaced ──────────────
process.env.DISABLE_REDIS = 'true';
// Nothing here may reach a real database from a developer's shell.
process.env.DATABASE_URL = 'postgres://pin:pin@127.0.0.1:1/archived_listing_pin';
function preload(rel, exports) {
  const file = require.resolve(path.join(API_SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const ACTOR = { id: 'user_pin', org_id: 'org_pin', workspace_key: 'org_pin', scopes: ['context:read', 'context:write'] };
const passThrough = (_req, _res, next) => next();
preload('middleware/auth', {
  requireAuth: (req, _res, next) => { req.actor = { ...ACTOR }; next(); },
  requireAnyScope: () => passThrough,
});
preload('middleware/rateLimit', new Proxy({}, { get: () => passThrough }));

// What is "stored". Each test sets these; both dispatchers read them through
// the same two service functions.
let TREE = [];
let ARCHIVED = [];
const service = require(path.join(API_SRC, 'services', 'contextSyncService'));
service.listProjectTree = async () => TREE;
service.listArchivedProjectSummaries = async (_actor, { limit = 10 } = {}) => ARCHIVED.slice(0, limit);

const contextRouter = require(path.join(API_SRC, 'routes', 'context', 'context-sync.js'));
const { dispatchTool } = require(path.join(API_SRC, 'routes', 'mcp.js'));
const express = require(require.resolve('express', { paths: [API_SRC] }));

function startApi() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    // The listing's two reads go to the REAL router.
    if (req.method === 'GET' && (req.path === '/api/v1/context/projects' || req.path === '/api/v1/context/projects/tree')) return next();
    // Everything start_session and telemetry ask for, answered as an account
    // with no live project would be.
    if (req.path === '/api/v1/context/map') return res.json({ map: '[DeerDawn — 0 projects]', project_count: 0 });
    return res.json({ ok: true, results: [], todos: [], cards: [], skills: [] });
  });
  app.use('/api/v1/context', contextRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
    }));
  });
}

async function connectLocal(api) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-archived-listing-')));
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd);
  const client = new Client({ name: 'archived-listing-parity', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      DEERDAWN_API_URL: api.url,
      DEERDAWN_API_KEY: `dd_archived_listing_${'a'.repeat(32)}`,
      CLAUDE_PROJECT_DIR: cwd,
      DEERDAWN_CAPTURE: 'off',
    },
    stderr: 'pipe',
  }));
  return { client, home };
}

const textOf = (result) => (result.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');

async function hostedListing() {
  const result = await dispatchTool('recall', { action: 'projects' }, { ...ACTOR }, 'claude_web', { readOnlyInvocation: true });
  return { text: textOf(result), data: result.structuredContent };
}

const LEDGER_API = { project_id: 'project_ledger_api', project_name: 'Ledger API', aliases: [], archived_at: '2026-08-24T03:00:00.000Z' };
const LEDGER_DASH = { project_id: 'project_ledger_dash', project_name: 'Ledger Dashboard', aliases: [], archived_at: '2026-08-24T03:00:00.000Z' };

test('recall(action:"projects"): the local server and the hosted connector say the same thing, and it names archived projects', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const { client, home } = await connectLocal(api);
  t.after(async () => { await client.close(); fs.rmSync(home, { recursive: true, force: true }); });

  // start_session first, as the local server requires; this is the notice that
  // sends the assistant to the listing.
  TREE = [];
  ARCHIVED = [LEDGER_DASH, LEDGER_API];
  const opened = textOf(await client.callTool({ name: 'start_session', arguments: {} }));
  assert.match(opened, /2 archived projects are waiting, not gone/, opened);
  assert.match(opened, /call recall\(action:"projects"\) for the IDs/);

  const scenarios = [
    ['every project archived (the walker\'s return)', [], [LEDGER_DASH, LEDGER_API]],
    ['one archived project', [], [LEDGER_API]],
    ['live projects and an archived one', [
      {
        project_id: 'project_umbrella', project_name: 'Umbrella', context: { current_task: 'ship v2' },
        subprojects: [{ project_id: 'project_sub', project_name: 'Sub', context: { current_task: 'auth' } }],
      },
      { project_id: 'project_solo', project_name: 'Solo', context: {} },
    ], [LEDGER_API]],
    ['nothing at all', [], []],
    ['live projects only', [{ project_id: 'project_solo', project_name: 'Solo', context: { current_task: 'write docs' } }], []],
  ];
  for (const [label, tree, archived] of scenarios) {
    TREE = tree;
    ARCHIVED = archived;
    const local = await client.callTool({ name: 'recall', arguments: { action: 'projects' } });
    const hosted = await hostedListing();
    assert.equal(local.isError, undefined, `${label}: local errored: ${textOf(local)}`);
    assert.equal(textOf(local), hosted.text, `${label}: the two dispatchers disagree`);

    if (archived.length) {
      for (const project of archived) {
        assert.ok(hosted.text.includes(`${project.project_name} (${project.project_id}) — archived 2026-08-24`), `${label}: ${project.project_name} is not listed with its id`);
      }
      assert.doesNotMatch(hosted.text, /No projects yet|0 projects\]/, `${label}: THE BUG — the listing says there are none`);
      assert.match(hosted.text, /manage_projects\(action:"restore", project_id:"/, `${label}: no restore call`);
      // The hosted structured half names the same ones the text does.
      assert.deepEqual(hosted.data.archived_projects.map((p) => p.project_id), archived.map((p) => p.project_id));
      assert.equal(hosted.data.archived_total, archived.length);
    } else {
      assert.equal(hosted.data.archived_projects, undefined, `${label}: archived keys on a reply with nothing archived`);
    }
    if (!tree.length && !archived.length) {
      assert.equal(hosted.text, 'No projects yet. Use manage_projects with action "create" to create one.');
    }
  }
});
