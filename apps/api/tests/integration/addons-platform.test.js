/**
 * THE ADD-ON PLATFORM, end to end over HTTP (and the hosted MCP dispatch).
 *
 *   1. Enable/disable is per workspace; in a team only an owner may switch it.
 *   2. A record is the person's alone: another member and a workspace OWNER
 *      cannot list, read, change or delete it, nor fetch its attachment.
 *   3. A viewer cannot write.
 *   4. read_addon (and `via: "read"`) cannot run a write action.
 *   5. Encrypted at rest when ENCRYPTION_MASTER_KEY is set.
 *   6. Upload links: bound to one person, one add-on, one collection; expire.
 *   7. Signed attachment links work without a session and only for their row.
 *   8. No storage configured: uploads answer 503, everything else works.
 *   9. Export carries the person's records and a listing of their files.
 *  10. Brief lines render only for enabled add-ons.
 *  11. Erasure (account, person, member removal) removes rows AND files.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/addons-platform.test.js
 */

process.env.NODE_ENV = 'test';
// Exercise the encrypted path (see CLAUDE.md, ENCRYPTION_MASTER_KEY).
process.env.ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { setStorageForTests } = require('../../src/addons/storage');
const { createLocalDiskStorage } = require('../../src/addons/storage/localDisk');
const signing = require('../../src/addons/signing');
const lifecycle = require('../../src/addons/lifecycle');
const registry = require('../../src/addons/registry');
const { purgeOwnerData, erasePersonData } = require('../../src/services/dataErasureService');
const { dispatchTool } = require('../../src/routes/mcp');

const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'addons-it-'));
setStorageForTests(createLocalDiskStorage(STORAGE_ROOT));
registry.reloadForTests(); // the real addons/ directory, notes-example included
const ADDON = 'notes-example';

async function makeOrg(label, plan = 'developer_pro') {
  const orgId = `org-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
    orgId,
  );
  return orgId;
}

async function makePerson(label, plan) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@addons.test`;
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function join(ownerKey, inviterId, joiner, role = 'member') {
  const invite = await workspace.createInvite(ownerKey, joiner.email, { role, invitedBy: inviterId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, urlPath, person, ws = null) {
  let r = request(httpServer)[method](urlPath).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const action = (person, ws, name, args, via) => as('post', `/api/v1/addons/${ADDON}/actions/${name}`, person, ws)
  .send({ args, ...(via ? { via } : {}) });

async function jpegWithExif() {
  return sharp({ create: { width: 320, height: 240, channels: 3, background: '#884422' } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Make: 'LeakyCamCo', Model: 'WhereAmI' } } })
    .toBuffer();
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else out.push(full);
    }
  };
  walk(root);
  return out;
}

const storageFilesFor = async (attachmentId) => filesUnder(STORAGE_ROOT).filter((f) => f.includes(attachmentId));

// One team for most cases: owner, member, viewer.
let owner;
let member;
let viewer;
let team;

test.before(async () => {
  owner = await makePerson('owner');
  member = await makePerson('member', 'free');
  viewer = await makePerson('viewer', 'free');
  team = owner.orgId;
  await join(team, owner.userId, member, 'member');
  await join(team, owner.userId, viewer, 'viewer');
});

test('1: catalog lists the add-on; only an owner may switch it on in a team; disabled actions refuse', async () => {
  const catalog = await as('get', '/api/v1/addons', member, team);
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const entry = catalog.body.addons.find((a) => a.id === ADDON);
  assert.ok(entry, 'notes-example is in the catalog');
  assert.equal(entry.enabled, false);

  const off = await action(member, team, 'list', { collection: 'notes' });
  assert.equal(off.status, 409);
  assert.equal(off.body.error, 'addon_disabled');

  const help = await action(member, team, 'help', {});
  assert.equal(help.status, 200, 'help answers while switched off');
  assert.ok(help.body.data.actions.some((a) => a.name === 'create' && a.mode === 'write'));

  const byMember = await as('post', `/api/v1/addons/${ADDON}/enable`, member, team);
  assert.equal(byMember.status, 403);
  const byOwner = await as('post', `/api/v1/addons/${ADDON}/enable`, owner, team);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  assert.equal(byOwner.body.addon.enabled, true);
});

test('2: a personal record is invisible to another member and to a workspace owner', async () => {
  const created = await action(member, team, 'create', { collection: 'notes', data: { title: 'member secret', tags: ['a'] } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.data.record.id;

  const mine = await action(member, team, 'list', { collection: 'notes' });
  assert.deepEqual(mine.body.data.rows.map((r) => r.id), [id]);
  const filtered = await action(member, team, 'list', { collection: 'notes', where: { tags: ['a', 'z'] } });
  assert.equal(filtered.body.data.rows.length, 1, 'where on an array field matches any of the values');
  const miss = await action(member, team, 'list', { collection: 'notes', where: { title: 'nope' } });
  assert.equal(miss.body.data.rows.length, 0);

  for (const other of [owner]) {
    const listed = await action(other, team, 'list', { collection: 'notes' });
    assert.equal(listed.status, 200);
    assert.ok(!listed.body.data.rows.some((r) => r.id === id), `${other.label} must not list it`);
    const got = await action(other, team, 'get', { collection: 'notes', id });
    assert.equal(got.body.data.record, null, `${other.label} must not read it`);
    const upd = await action(other, team, 'update', { collection: 'notes', id, patch: { title: 'hijacked' } });
    assert.equal(upd.body.data.record, null, `${other.label} must not change it`);
    const del = await action(other, team, 'remove', { collection: 'notes', id });
    assert.equal(del.body.data.removed, false, `${other.label} must not delete it`);
    const count = await action(other, team, 'count', { collection: 'notes' });
    assert.equal(count.body.data.count, 0);
  }
  const still = await action(member, team, 'get', { collection: 'notes', id });
  assert.equal(still.body.data.record.data.title, 'member secret');

  // And its attachment.
  const upload = await as('post', `/api/v1/addons/${ADDON}/attachments`, member, team)
    .field('collection', 'notes').field('record_id', id)
    .attach('file', await jpegWithExif(), { filename: 'photo.jpg', contentType: 'image/jpeg' });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const attId = upload.body.attachment.id;
  assert.equal(upload.body.attachment.record_id, id);

  const own = await as('get', `/api/v1/addons/${ADDON}/attachments/${attId}?variant=original`, member, team).buffer(true);
  assert.equal(own.status, 200);
  assert.ok(!own.body.includes(Buffer.from('LeakyCamCo')), 'stored original carries no EXIF');
  for (const variant of ['thumb', 'view', 'original']) {
    const res = await as('get', `/api/v1/addons/${ADDON}/attachments/${attId}?variant=${variant}`, owner, team);
    assert.equal(res.status, 404, `owner must not fetch the ${variant}`);
  }
  const delByOwner = await as('delete', `/api/v1/addons/${ADDON}/attachments/${attId}`, owner, team);
  assert.equal(delByOwner.status, 404);
  for (const file of await storageFilesFor(attId)) {
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('LeakyCamCo')), `${path.basename(file)} on disk has no EXIF`);
  }
});

test('2a: an iPhone HEIC upload is accepted, stored as JPEG with no EXIF', async () => {
  const heic = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'addons', 'photo.heic'));
  const up = await as('post', `/api/v1/addons/${ADDON}/attachments`, member, team)
    .field('collection', 'notes').attach('file', heic, { filename: 'IMG_0001.HEIC', contentType: 'image/heic' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.attachment.mime, 'image/jpeg');
  assert.deepEqual([up.body.attachment.width, up.body.attachment.height], [40, 64]);
  const original = await as('get', `/api/v1/addons/${ADDON}/attachments/${up.body.attachment.id}?variant=original`, member, team).buffer(true);
  assert.equal(original.status, 200);
  assert.equal(original.headers['content-type'], 'image/jpeg');
  assert.ok(!original.body.includes(Buffer.from('SecretCamCo')));
  const broken = await as('post', `/api/v1/addons/${ADDON}/attachments`, member, team)
    .field('collection', 'notes').attach('file', heic.subarray(0, 300), { filename: 'broken.heic' });
  assert.equal(broken.status, 415);
  assert.equal(broken.body.error, 'addon_heic_unreadable');
});

test('2b: schema validation refuses a record that does not match', async () => {
  const res = await action(member, team, 'create', { collection: 'notes', data: { body: 'no title' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'addon_invalid_record');
  const unknown = await action(member, team, 'create', { collection: 'nope', data: { title: 'x' } });
  assert.equal(unknown.status, 400);
});

test('3: a viewer cannot write, but can read their own (empty) data', async () => {
  const res = await action(viewer, team, 'create', { collection: 'notes', data: { title: 'viewer write' } });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  const upload = await as('post', `/api/v1/addons/${ADDON}/attachments`, viewer, team)
    .field('collection', 'notes').attach('file', await jpegWithExif(), 'p.jpg');
  assert.equal(upload.status, 403);
  const read = await action(viewer, team, 'list', { collection: 'notes' });
  assert.equal(read.status, 200);
});

test('4: read_addon and via:"read" cannot run a write action', async () => {
  const http = await action(member, team, 'create', { collection: 'notes', data: { title: 'via read' } }, 'read');
  assert.equal(http.status, 403);
  assert.equal(http.body.error, 'addon_write_via_read');

  const actor = { type: 'user', id: member.userId, org_id: member.orgId, workspace_key: team, role: 'admin', scopes: ['context:read', 'context:write'] };
  await assert.rejects(
    dispatchTool('read_addon', { addon: ADDON, action: 'create', args: { collection: 'notes', data: { title: 'mcp read' } } }, actor),
    (err) => err.code === 'addon_write_via_read',
  );
  const listed = await dispatchTool('read_addon', { addon: ADDON, action: 'list', args: { collection: 'notes', include_data: true } }, actor);
  assert.ok(listed.structuredContent.data.rows.every((r) => r.data.title !== 'via read' && r.data.title !== 'mcp read'));
  const written = await dispatchTool('use_addon', { addon: ADDON, action: 'create', args: { collection: 'notes', data: { title: 'mcp write' } } }, actor);
  assert.match(written.content[0].text, /Saved notes record/);
});

test('4b: over MCP a reply is text (carrying the records) unless include_data is passed; HTTP keeps data', async () => {
  const actor = { type: 'user', id: member.userId, org_id: member.orgId, workspace_key: team, role: 'admin', scopes: ['context:read', 'context:write'] };
  const lean = await dispatchTool('read_addon', { addon: ADDON, action: 'list', args: { collection: 'notes' } }, actor);
  assert.equal(lean.structuredContent.data, undefined, 'no data by default');
  assert.match(lean.content[0].text, /member secret/, 'the text carries the records');
  assert.match(lean.content[0].text, /^- rec_/m);
  const full = await dispatchTool('read_addon', { addon: ADDON, action: 'list', args: { collection: 'notes', include_data: true } }, actor);
  assert.ok(Array.isArray(full.structuredContent.data.rows), 'include_data: true adds data');
  assert.ok(full.content[0].text.length > 0);
  const help = await dispatchTool('read_addon', { addon: ADDON, action: 'help' }, actor);
  assert.equal(help.structuredContent.data, undefined);
  assert.match(help.content[0].text, /args: \{"properties":\{"collection"/, 'help text carries the argument shapes');
  const http = await action(member, team, 'list', { collection: 'notes', include_data: false });
  assert.equal(http.status, 200, 'include_data never trips the action schema');
  assert.ok(Array.isArray(http.body.data.rows), 'HTTP always returns data');
});

test('5: record data is encrypted at rest and decrypted on read', async () => {
  const created = await action(member, team, 'create', { collection: 'notes', data: { title: 'plaintext marker 7731' } });
  const raw = await db.query('SELECT data FROM addon_records WHERE id = $1', [created.body.data.record.id], 'org-system');
  assert.ok(raw.rows[0].data._enc, 'stored as { _enc }');
  assert.ok(!JSON.stringify(raw.rows[0].data).includes('7731'));
  const got = await action(member, team, 'get', { collection: 'notes', id: created.body.data.record.id });
  assert.equal(got.body.data.record.data.title, 'plaintext marker 7731');
});

test('6: an upload link is bound to one person, one add-on, one collection, and expires', async () => {
  const link = await signing.createUploadToken({ ownerKey: team, personId: member.userId, addonId: ADDON, collection: 'notes', base: '' });
  const stored = await db.query('SELECT token_hash FROM addon_upload_tokens WHERE person_id = $1', [member.userId], 'org-system');
  assert.ok(stored.rows.every((r) => r.token_hash !== link.token), 'only the hash is stored');

  const form = await request(httpServer).get(`/api/v1/addons/${ADDON}/upload/${link.token}`);
  assert.equal(form.status, 200);
  assert.match(form.text, /<form method="post" enctype="multipart\/form-data">/);

  const wrongAddon = await request(httpServer).get(`/api/v1/addons/other-addon/upload/${link.token}`);
  assert.equal(wrongAddon.status, 404);

  const posted = await request(httpServer).post(`/api/v1/addons/${ADDON}/upload/${link.token}`)
    .set('Accept', 'application/json')
    .attach('file', await jpegWithExif(), 'a.jpg')
    .attach('file', Buffer.from('renamed text file pretending to be a photo'), 'b.jpg');
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.attachments.length, 1);
  assert.equal(posted.body.failed.length, 1, 'the renamed text file is refused by sniffing');
  assert.equal(posted.body.failed[0].error, 'addon_unsupported_type');
  const row = await db.query('SELECT person_id, owner_key, collection FROM addon_attachments WHERE id = $1', [posted.body.attachments[0].id], 'org-system');
  assert.deepEqual(row.rows[0], { person_id: member.userId, owner_key: team, collection: 'notes' });
  const ownerFetch = await as('get', `/api/v1/addons/${ADDON}/attachments/${posted.body.attachments[0].id}`, owner, team);
  assert.equal(ownerFetch.status, 404, 'the uploaded file is the token holder\'s, not the owner\'s');

  // An upload-link file is on no record yet; the person lists it, the owner does not.
  const unlinked = await as('get', `/api/v1/addons/${ADDON}/attachments?collection=notes`, member, team);
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
  assert.ok(unlinked.body.attachments.some((a) => a.id === posted.body.attachments[0].id && a.record_id === null));
  assert.ok(unlinked.body.attachments.every((a) => a.record_id === null));
  const ownersUnlinked = await as('get', `/api/v1/addons/${ADDON}/attachments?collection=notes`, owner, team);
  assert.ok(!ownersUnlinked.body.attachments.some((a) => a.id === posted.body.attachments[0].id));

  await db.query('UPDATE addon_upload_tokens SET expires_at = NOW() - interval \'1 second\' WHERE token_hash = $1', [signing.hashToken(link.token)], 'org-system');
  const expired = await request(httpServer).post(`/api/v1/addons/${ADDON}/upload/${link.token}`)
    .set('Accept', 'application/json').attach('file', await jpegWithExif(), 'c.jpg');
  assert.equal(expired.status, 404);
  assert.equal(expired.body.error, 'addon_upload_link_expired');
  const expiredForm = await request(httpServer).get(`/api/v1/addons/${ADDON}/upload/${link.token}`);
  assert.equal(expiredForm.status, 404);
});

test('7: a signed link works without a session, and only for its own row', async () => {
  const up = await as('post', `/api/v1/addons/${ADDON}/attachments`, member, team)
    .field('collection', 'notes').attach('file', await jpegWithExif(), 'x.jpg');
  const attId = up.body.attachment.id;
  const url = signing.signedAttachmentUrl({ addonId: ADDON, attachmentId: attId, variant: 'thumb', ownerKey: team, personId: member.userId, base: '' });
  const ok = await request(httpServer).get(url);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/webp');
  const tampered = await request(httpServer).get(url.replace('variant=thumb', 'variant=original'));
  assert.equal(tampered.status, 403);
  const forged = signing.signedAttachmentUrl({ addonId: ADDON, attachmentId: attId, variant: 'thumb', ownerKey: team, personId: owner.userId, base: '' });
  assert.equal((await request(httpServer).get(forged)).status, 403, 'signed for the wrong person');
});

test('8: with no storage configured, uploads answer 503 and actions still work', async () => {
  setStorageForTests(null);
  try {
    const up = await as('post', `/api/v1/addons/${ADDON}/attachments`, member, team)
      .field('collection', 'notes').attach('file', await jpegWithExif(), 'x.jpg');
    assert.equal(up.status, 503);
    assert.equal(up.body.error, 'addon_storage_unavailable');
    const list = await action(member, team, 'list', { collection: 'notes' });
    assert.equal(list.status, 200);
  } finally {
    setStorageForTests(createLocalDiskStorage(STORAGE_ROOT));
  }
});

test('9: the account export carries this person\'s records and a listing of their files, nobody else\'s', async () => {
  const res = await as('get', '/api/v1/context/export', member, team);
  assert.equal(res.status, 200);
  const bundle = JSON.parse(res.text);
  assert.ok(bundle.addons, 'bundle has an addons section');
  assert.ok(bundle.addons.records.some((r) => r.data.title === 'member secret'));
  assert.ok(bundle.addons.attachments.length >= 1);
  assert.ok(bundle.addons.attachments.every((a) => a.download && a.sha256));
  const ownerBundle = JSON.parse((await as('get', '/api/v1/context/export', owner, team)).text);
  assert.ok(!ownerBundle.addons.records.some((r) => r.data.title === 'member secret'), 'the owner\'s export does not carry the member\'s records');
  const md = await as('get', '/api/v1/context/export?format=markdown', member, team);
  assert.match(md.text, /## Add-ons \(/);
});

test('10: brief lines render for enabled add-ons only, per person', async () => {
  const actor = { type: 'user', id: member.userId, org_id: member.orgId, workspace_key: team, role: 'admin' };
  const lines = await lifecycle.briefLines(actor);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Notes: \d+ saved$/);
  const solo = await makePerson('solo');
  assert.deepEqual(await lifecycle.briefLines({ type: 'user', id: solo.userId, org_id: solo.orgId, role: 'admin' }), [], 'nothing when no add-on is on');
});

test('11a: member removal erases that member\'s add-on rows and files in that workspace', async () => {
  const leaver = await makePerson('leaver', 'free');
  await join(team, owner.userId, leaver, 'member');
  const created = await action(leaver, team, 'create', { collection: 'notes', data: { title: 'leaving soon' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const up = await as('post', `/api/v1/addons/${ADDON}/attachments`, leaver, team)
    .field('collection', 'notes').attach('file', await jpegWithExif(), 'l.jpg');
  assert.equal(up.status, 201);
  assert.equal((await storageFilesFor(up.body.attachment.id)).length, 3);

  const removed = await as('delete', `/api/v1/teams/members/${leaver.userId}`, owner, team);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const rows = await db.query('SELECT count(*)::int AS n FROM addon_records WHERE person_id = $1 AND owner_key = $2', [leaver.userId, team], 'org-system');
  assert.equal(rows.rows[0].n, 0);
  assert.equal((await storageFilesFor(up.body.attachment.id)).length, 0, 'files deleted');
});

test('11b: account erasure removes workspace_addons, records, attachments, tokens and files, with counts', async () => {
  const solo = await makePerson('erase-me');
  assert.equal((await as('post', `/api/v1/addons/${ADDON}/enable`, solo)).status, 200);
  assert.equal((await action(solo, null, 'create', { collection: 'notes', data: { title: 'gone soon' } })).status, 200);
  const up = await as('post', `/api/v1/addons/${ADDON}/attachments`, solo).field('collection', 'notes').attach('file', await jpegWithExif(), 'e.jpg');
  assert.equal(up.status, 201);
  await signing.createUploadToken({ ownerKey: solo.orgId, personId: solo.userId, addonId: ADDON, collection: 'notes', base: '' });
  assert.equal((await storageFilesFor(up.body.attachment.id)).length, 3);

  const deleted = await purgeOwnerData(solo.orgId, { strict: true, userIds: [solo.userId] });
  for (const table of ['workspace_addons', 'addon_records', 'addon_attachments', 'addon_upload_tokens']) {
    assert.equal(typeof deleted[table], 'number', `${table} reported: ${deleted[table]}`);
    assert.ok(deleted[table] >= 1, `${table} counted its rows`);
  }
  assert.equal(deleted.addon_files_deleted, 3);
  for (const table of ['workspace_addons', 'addon_records', 'addon_attachments', 'addon_upload_tokens']) {
    const left = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_key = $1`, [solo.orgId], 'org-system');
    assert.equal(left.rows[0].n, 0, `${table} emptied`);
  }
  assert.equal((await storageFilesFor(up.body.attachment.id)).length, 0);
});

test('11c: erasing a person removes their add-on data in other people\'s workspaces too', async () => {
  const guest = await makePerson('guest', 'free');
  await join(team, owner.userId, guest, 'member');
  assert.equal((await action(guest, team, 'create', { collection: 'notes', data: { title: 'guest note' } })).status, 200);
  const up = await as('post', `/api/v1/addons/${ADDON}/attachments`, guest, team).field('collection', 'notes').attach('file', await jpegWithExif(), 'g.jpg');
  assert.equal(up.status, 201);

  const deleted = await erasePersonData({ userIds: [guest.userId] });
  assert.ok(deleted.addon_records_by_person >= 1);
  assert.ok(deleted.addon_attachments_by_person >= 1);
  assert.equal(deleted.addon_files_deleted, 3);
  const left = await db.query('SELECT count(*)::int AS n FROM addon_records WHERE person_id = $1', [guest.userId], 'org-system');
  assert.equal(left.rows[0].n, 0);
  // The member's own note in the same team is untouched.
  const kept = await action(member, team, 'list', { collection: 'notes', where: { title: 'member secret' } });
  assert.equal(kept.body.data.rows.length, 1);
});
