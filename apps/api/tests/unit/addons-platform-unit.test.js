'use strict';

// The add-on platform's pieces that need no database: the manifest validator,
// the boot loader's tolerance of broken add-ons, image ingest (EXIF really
// gone, type sniffed from bytes), the SigV4 signer and the disk adapter's
// refusal to leave its root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const kit = require('../../../../packages/addon-kit/src');
const { loadAddons, DEFAULT_ADDONS_DIR } = require('../../src/addons/loader');
const { processImage, sniffImageType } = require('../../src/addons/imageIngest');
const { signRequest } = require('../../src/addons/storage/s3');
const { createLocalDiskStorage } = require('../../src/addons/storage/localDisk');
const { resolveStorageConfig } = require('../../src/addons/storage');

const quietLog = { log() {}, warn() {} };

function writeAddon(root, id, files) {
  const dir = path.join(root, id);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

const NOTE_SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };

test('manifest validation rejects bad input with a reason', () => {
  const good = JSON.parse(fs.readFileSync(path.join(DEFAULT_ADDONS_DIR, 'notes-example', 'addon.json'), 'utf8'));
  assert.deepEqual(kit.validateManifest(good), { ok: true, errors: [] });
  for (const [bad, pattern] of [
    [{ ...good, id: '../escape' }, /"id"/],
    [{ ...good, kind: 'binary' }, /"kind"/],
    [{ ...good, collections: { notes: { schema: '../../secrets.json' } } }, /relative path/],
    [{ ...good, brief_line: '{{notes.data}}' }, /only substitution/],
    [{ ...good, default_visibility: 'shared' }, /personal/],
  ]) {
    const verdict = kit.validateManifest(bad);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => pattern.test(e)), verdict.errors.join('; '));
  }
});

test('the in-repo example add-on loads with generic actions', () => {
  const { addons, skipped } = loadAddons({ dir: DEFAULT_ADDONS_DIR, env: {}, log: quietLog });
  const notes = addons.get('notes-example');
  assert.ok(notes, `notes-example should load; skipped: ${JSON.stringify(skipped)}`);
  assert.deepEqual(Object.keys(notes.actions).sort(), ['count', 'create', 'get', 'list', 'remove', 'update']);
  assert.equal(notes.actions.create.mode, 'write');
  assert.equal(notes.actions.list.mode, 'read');
  assert.equal(notes.collections.notes.attachments, true);
});

test('a broken add-on is skipped and logged, and boot goes on', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addons-load-'));
  writeAddon(root, 'good-one', {
    'addon.json': { id: 'good-one', name: 'Good', version: '1.0.0', kind: 'declarative', collections: { notes: { schema: 's.json' } } },
    's.json': NOTE_SCHEMA,
  });
  writeAddon(root, 'bad-json', { 'addon.json': '{ not json' });
  writeAddon(root, 'bad-manifest', { 'addon.json': { id: 'bad-manifest', name: 'X', version: 'nope', kind: 'declarative', collections: {} } });
  writeAddon(root, 'missing-schema', {
    'addon.json': { id: 'missing-schema', name: 'X', version: '1.0.0', kind: 'declarative', collections: { a: { schema: 'nope.json' } } },
  });
  writeAddon(root, 'throws-on-require', {
    'addon.json': { id: 'throws-on-require', name: 'X', version: '1.0.0', kind: 'server', collections: { a: { schema: 's.json' } } },
    's.json': NOTE_SCHEMA,
    'index.js': 'throw new Error("boom at require time");',
  });
  writeAddon(root, 'bad-actions', {
    'addon.json': { id: 'bad-actions', name: 'X', version: '1.0.0', kind: 'server', collections: { a: { schema: 's.json' } } },
    's.json': NOTE_SCHEMA,
    'index.js': 'module.exports = { actions: { help: { mode: "read", description: "x", handler: async () => ({ text: "" }) } } };',
  });
  writeAddon(root, 'wrong-dir-name', {
    'addon.json': { id: 'other-id', name: 'X', version: '1.0.0', kind: 'declarative', collections: { a: { schema: 's.json' } } },
    's.json': NOTE_SCHEMA,
  });

  const warnings = [];
  const { addons, skipped } = loadAddons({ dir: root, env: {}, log: { log() {}, warn: (m) => warnings.push(m) } });
  assert.deepEqual([...addons.keys()], ['good-one']);
  const reasons = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  assert.match(reasons['bad-json'], /not valid JSON/);
  assert.match(reasons['bad-manifest'], /invalid manifest/);
  assert.match(reasons['missing-schema'], /cannot read schema/);
  assert.match(reasons['throws-on-require'], /boom at require time/);
  assert.match(reasons['bad-actions'], /reserved/);
  assert.match(reasons['wrong-dir-name'], /must equal the manifest id/);
  assert.equal(warnings.length, 6, 'each skip is logged');
});

test('DEERDAWN_ADDONS is an allowlist; unset or empty means all, "none" means none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addons-allow-'));
  for (const id of ['alpha', 'beta']) {
    writeAddon(root, id, {
      'addon.json': { id, name: id, version: '1.0.0', kind: 'declarative', collections: { a: { schema: 's.json' } } },
      's.json': NOTE_SCHEMA,
    });
  }
  const ids = (env) => [...loadAddons({ dir: root, env, log: quietLog }).addons.keys()];
  assert.deepEqual(ids({}), ['alpha', 'beta']);
  assert.deepEqual(ids({ DEERDAWN_ADDONS: '' }), ['alpha', 'beta']);
  assert.deepEqual(ids({ DEERDAWN_ADDONS: 'beta' }), ['beta']);
  assert.deepEqual(ids({ DEERDAWN_ADDONS: 'none' }), []);
});

test('a missing add-ons directory loads nothing and does not throw', () => {
  const { addons, skipped } = loadAddons({ dir: path.join(os.tmpdir(), 'no-such-addons-dir-xyz'), env: {}, log: quietLog });
  assert.equal(addons.size, 0);
  assert.equal(skipped.length, 0);
});

test('EXIF (camera, GPS) is gone from every stored variant, and orientation is applied', async () => {
  const input = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#336699' } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'SecretCamCo', Model: 'GPS-Phone-9' } } })
    .toBuffer();
  assert.ok(input.includes(Buffer.from('SecretCamCo')), 'fixture carries EXIF');

  const out = await processImage(input);
  assert.equal(out.mime, 'image/jpeg');
  assert.deepEqual([out.width, out.height], [200, 400], 'orientation 6 rotates the stored image');
  for (const [variant, bytes] of Object.entries(out.variants)) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.exif, undefined, `${variant} has no EXIF block`);
    assert.ok(!bytes.includes(Buffer.from('SecretCamCo')), `${variant} bytes do not carry the camera make`);
    assert.ok(!bytes.includes(Buffer.from('Exif\0\0')), `${variant} has no APP1 Exif header`);
  }
  assert.ok((await sharp(out.variants.thumb).metadata()).height <= 256);
  assert.ok((await sharp(out.variants.view).metadata()).height <= 1024);
});

test('the type is sniffed from bytes: a renamed text file is refused', async () => {
  const text = Buffer.from('this is not a photo, whatever the filename says '.repeat(4));
  assert.equal(sniffImageType(text), null);
  await assert.rejects(processImage(text), (err) => err.status === 415 && err.code === 'addon_unsupported_type');
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff' } }).png().toBuffer();
  assert.equal(sniffImageType(png), 'png');
  // A JPEG header on garbage is sniffed as JPEG, then refused by the decoder.
  const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  await assert.rejects(processImage(fake), (err) => err.status === 415);
});

test('SigV4 matches the AWS published GET Object example', () => {
  const headers = signRequest({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.Authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('local disk storage never leaves its root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addons-disk-'));
  const storage = createLocalDiskStorage(root);
  await storage.put('notes/att_1/thumb.webp', Buffer.from('x'));
  assert.equal(String(await storage.get('notes/att_1/thumb.webp')), 'x');
  assert.equal(await storage.get('notes/att_1/missing'), null);
  for (const key of ['../outside', 'a/../../b', '/etc/passwd', 'a\\b']) {
    await assert.rejects(storage.put(key, Buffer.from('x')), /invalid storage key|escapes/);
  }
  assert.equal(await storage.delete('notes/att_1/thumb.webp'), true);
  assert.equal(await storage.delete('notes/att_1/thumb.webp'), false);
});

test('storage is chosen by env, and hosted production with nothing configured has none', () => {
  assert.equal(resolveStorageConfig({ NODE_ENV: 'production' }).kind, 'none');
  assert.deepEqual(resolveStorageConfig({ NODE_ENV: 'production', SELF_HOSTED: 'true' }), { kind: 'local', dir: '/data/addons' });
  assert.deepEqual(resolveStorageConfig({ NODE_ENV: 'production', ADDON_STORAGE_DIR: '/srv/a' }), { kind: 'local', dir: '/srv/a' });
  const s3 = resolveStorageConfig({ NODE_ENV: 'production', ADDON_S3_BUCKET: 'b', ADDON_S3_ENDPOINT: 'https://fly.storage.tigris.dev', ADDON_S3_ACCESS_KEY_ID: 'k', ADDON_S3_SECRET_ACCESS_KEY: 's' });
  assert.equal(s3.kind, 's3');
  assert.equal(s3.region, 'auto');
});

test('an add-on directory can require sharp (it is a root dependency, so it installs at the repo root)', () => {
  const resolved = require.resolve('sharp', { paths: [path.join(DEFAULT_ADDONS_DIR, 'notes-example')] });
  assert.ok(resolved.includes(`${path.sep}node_modules${path.sep}sharp${path.sep}`));
  assert.ok(!resolved.includes(`${path.sep}apps${path.sep}api${path.sep}node_modules`), 'not only the API\'s private copy');
});

// ── HEIC / HEIF (iPhone photos) ─────────────────────────────────────────────
// tests/fixtures/addons/photo.heic: a 64x40 HEVC-coded HEIC written by macOS
// ImageIO, carrying an Exif item (Make "SecretCamCo", Model "GPS-Phone-9", a GPS
// position) and an `irot` box rotating it to portrait. A red stripe sits on the
// left of the unrotated image, so after rotation it is along the top.
const HEIC_FIXTURE = path.join(__dirname, '..', 'fixtures', 'addons', 'photo.heic');

test('a real HEIC decodes to the three variants, rotated, with no EXIF', async () => {
  const input = fs.readFileSync(HEIC_FIXTURE);
  assert.equal(sniffImageType(input), 'heif');
  assert.ok(input.includes(Buffer.from('SecretCamCo')), 'fixture carries EXIF');

  const out = await processImage(input);
  assert.equal(out.mime, 'image/jpeg', 'the original is stored as JPEG');
  assert.deepEqual([out.width, out.height], [40, 64], 'the irot rotation is applied');
  for (const [variant, bytes] of Object.entries(out.variants)) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.format, variant === 'original' ? 'jpeg' : 'webp');
    assert.deepEqual([meta.width, meta.height], [40, 64], `${variant} keeps the orientation`);
    assert.equal(meta.exif, undefined, `${variant} has no EXIF block`);
    assert.ok(!bytes.includes(Buffer.from('SecretCamCo')) && !bytes.includes(Buffer.from('GPS-Phone-9')), `${variant} carries no camera data`);
  }
  const { data, info } = await sharp(out.variants.original).raw().toBuffer({ resolveWithObject: true });
  const top = [data[0], data[1], data[2]];
  const bottom = [data[(info.height - 1) * info.width * info.channels], data[(info.height - 1) * info.width * info.channels + 1]];
  assert.ok(top[0] > 200 && top[1] < 60, `the red stripe is on top after rotation, got ${top}`);
  assert.ok(bottom[0] < 120, `and not at the bottom, got ${bottom}`);
});

test('a truncated or corrupt HEIC is refused with a clear message, and the process carries on', async () => {
  const input = fs.readFileSync(HEIC_FIXTURE);
  const truncated = input.subarray(0, Math.floor(input.length / 2));
  await assert.rejects(processImage(truncated), (err) => err.status === 415 && err.code === 'addon_heic_unreadable' && /damaged or incomplete/.test(err.message));
  const corrupt = Buffer.concat([input.subarray(0, 40), Buffer.alloc(input.length - 40, 0x5a)]);
  await assert.rejects(processImage(corrupt), (err) => err.status === 415 && /^addon_heic_/.test(err.code));
  const headerOnly = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
  await assert.rejects(processImage(headerOnly), (err) => err.status === 415);
  // Still decoding afterwards: a bad file leaves the decoder usable.
  assert.deepEqual([(await processImage(input)).width], [40]);
});

test('a file named .heic is judged by its bytes', async () => {
  const text = Buffer.from('definitely not a photo, despite being called IMG_0001.HEIC '.repeat(3));
  assert.equal(sniffImageType(text), null);
  await assert.rejects(processImage(text), (err) => err.code === 'addon_unsupported_type');
  // A real JPEG renamed .heic is accepted as the JPEG it is.
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer();
  assert.equal(sniffImageType(jpeg), 'jpeg');
  assert.equal((await processImage(jpeg)).mime, 'image/jpeg');
});

test('the HEIC decoder is not loaded until a HEIC arrives', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'addons', 'imageIngest.js'))});
    process.stdout.write(String(Object.keys(require.cache).some((k) => k.includes('libheif-js'))));
  `]).toString();
  assert.equal(out, 'false');
});
