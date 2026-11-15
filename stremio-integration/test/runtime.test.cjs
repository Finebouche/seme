'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { scan, identity } = require('../lib/runtime.cjs');
const { validateConfig } = require('../lib/config.cjs');

function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [encode(key), encode(value[key])]), Buffer.from('e')]);
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'seme-runtime-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const config = validateConfig({ cacheDir: path.join(temp, 'cache'), destinationDir: path.join(temp, 'preserved'), minFreeBytes: 0,
    client: { type: 'qbittorrent', url: 'http://127.0.0.1:8099', username: 'user', password: 'test-secret' } });
  const contents = [Buffer.from('abc'), Buffer.from('FIRST!'), Buffer.from('SECOND'), Buffer.from('THIRD!!')];
  const names = ['before.bin', 'episode1.mkv', 'episode2.mkv', 'episode3.mkv'];
  const all = Buffer.concat(contents), pieces = [];
  for (let i = 0; i < all.length; i += 4) pieces.push(crypto.createHash('sha1').update(all.subarray(i, i + 4)).digest());
  const info = encode({ name: 'Season', 'piece length': 4, pieces: Buffer.concat(pieces), files: contents.map((data, i) => ({ length: data.length, path: [names[i]] })) });
  const hash = crypto.createHash('sha1').update(info).digest('hex');
  const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
  const source = path.join(config.cacheDir, hash);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'cache'), torrent);
  await fs.writeFile(path.join(source, 'bitfield'), Buffer.from([0xe0]));
  for (let i = 0; i < contents.length; i++) await fs.writeFile(path.join(source, String(i)), contents[i]);
  const stateDir = path.join(temp, 'state');
  const client = new FakeClient(contents, names);
  const run = () => scan(config, { stateDir, client, verifyTimeoutMs: 100 });
  const savePath = path.join(config.destinationDir, hash);
  // Journal identity includes the canonical destination used by runtime.
  const journalPath = async () => path.join(stateDir, identity({ ...config, destinationDir: await fs.realpath(config.destinationDir) }), `${hash}.json`);
  return { temp, config, source, hash, torrent, contents, names, stateDir, client, run, savePath, journalPath };
}

class FakeClient {
  constructor(contents, names) { this.contents = contents; this.names = names; this.events = []; this.live = null; this.failVerification = false; this.loseAddResponse = false; this.verified = false; }
  async inspect(hash) { return this.live && this.live.hash === hash ? { ...this.live, files: this.live.files.map(file => ({ ...file })) } : null; }
  async addPaused({ hash, torrent, savePath, selected, files }) {
    assert.equal(this.live, null, 'add must never replace an existing torrent');
    assert.ok(Buffer.isBuffer(torrent));
    this.events.push({ action: 'addPaused', selected: [...selected], savePath });
    this.live = { hash, savePath, marker: 'seme-test-owned', paused: true, checking: false,
      files: files.map(file => ({ index: file.index, path: file.path, length: file.length, completed: 0 })) };
    if (this.failAddedSetup) {
      const error = new Error('Added torrent but per-torrent setup failed');
      error.code = 'ADDED_SETUP_FAILED';
      error.ownership = { added: true, hash, savePath, marker: this.live.marker };
      throw error;
    }
    if (this.loseAddResponse) { const error = new Error('Response lost after adding'); error.code = 'ETIMEDOUT'; throw error; }
    return { added: true, hash, savePath, marker: this.live.marker };
  }
  async pause(hash) { assert.equal(hash, this.live.hash); this.events.push({ action: 'pause' }); this.live.paused = true; }
  async select(hash, selected) { assert.equal(hash, this.live.hash); assert.equal(this.live.paused, true); this.events.push({ action: 'select', selected: [...selected] }); this.selected = [...selected]; this.verified = false; }
  async verify(hash) { assert.equal(hash, this.live.hash); assert.equal(this.live.paused, true); this.events.push({ action: 'verify' }); this.verified = false; }
  async waitVerified(hash, selected) {
    assert.equal(hash, this.live.hash); assert.equal(this.live.paused, true);
    this.events.push({ action: 'waitVerified', selected: [...selected] });
    if (this.failVerification) { const error = new Error('Verification failed'); error.code = 'VERIFY_FAILED'; throw error; }
    for (const index of selected) {
      assert.deepEqual(await fs.readFile(path.join(this.live.savePath, 'Season', this.names[index])), this.contents[index], `selected file ${index} must be complete before resume`);
      this.live.files[index].completed = this.contents[index].length;
    }
    this.verified = true;
    this.events.push({ action: 'verified' });
  }
  async resume(hash) { assert.equal(hash, this.live.hash); assert.equal(this.verified, true, 'cannot resume before successful verification'); assert.equal(this.live.paused, true); this.events.push({ action: 'resume' }); this.live.paused = false; }
}

test('initial transfer adds stopped, selects one episode, verifies before resume and repeated scans are no-ops', async t => {
  const f = await fixture(t);
  const report = await f.run();
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(f.client.events.map(e => e.action), ['addPaused', 'pause', 'select', 'verify', 'waitVerified', 'verified', 'resume']);
  assert.deepEqual(f.client.events.find(e => e.action === 'select').selected, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.savePath, 'Season/episode1.mkv')), f.contents[1]);
  assert.equal((await fs.stat(path.join(f.savePath, 'Season/episode2.mkv'))).size, 3);
  await assert.rejects(fs.stat(path.join(f.savePath, 'Season/episode3.mkv')), { code: 'ENOENT' });
  const job = JSON.parse(await fs.readFile(await f.journalPath(), 'utf8'));
  assert.equal(job.phase, 'ready'); assert.deepEqual(job.selected, [1]); assert.equal(job.pending, undefined);
  f.client.events.length = 0;
  assert.equal((await f.run()).imported, 0);
  assert.deepEqual(f.client.events, []);
});

test('second episode merges only its covering ranges and preserves first episode and unrelated suffix bytes', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).imported, 1);
  const first = path.join(f.savePath, 'Season/episode1.mkv');
  const inode = (await fs.stat(first)).ino;
  // The next snapshot needs only FIRST!'s last byte. Any whole-file recopy from
  // this deliberately changed prefix would destroy the already preserved file.
  await fs.writeFile(path.join(f.source, '1'), 'xxxxx!');
  await fs.writeFile(path.join(f.savePath, 'Season/episode3.mkv'), 'QQQQQQQ');
  await fs.writeFile(path.join(f.source, 'bitfield'), Buffer.from([0xf0]));
  f.client.events.length = 0;
  const report = await f.run();
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.equal(f.client.events.some(e => e.action === 'addPaused'), false);
  assert.deepEqual(f.client.events.find(e => e.action === 'select').selected, [1, 2]);
  assert.deepEqual(await fs.readFile(first), f.contents[1]);
  assert.equal((await fs.stat(first)).ino, inode);
  assert.deepEqual(await fs.readFile(path.join(f.savePath, 'Season/episode2.mkv')), f.contents[2]);
  assert.equal(await fs.readFile(path.join(f.savePath, 'Season/episode3.mkv'), 'utf8'), 'TQQQQQQ');
  const job = JSON.parse(await fs.readFile(await f.journalPath(), 'utf8'));
  assert.deepEqual(job.selected, [1, 2]);
});

test('foreign existing torrent is inspected but never paused, selected, copied or adopted', async t => {
  const f = await fixture(t);
  f.client.live = { hash: f.hash, savePath: path.join(f.temp, 'foreign'), marker: 'foreign', paused: false, checking: false, files: [] };
  const report = await f.run();
  assert.equal(report.imported, 0); assert.equal(report.skipped, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(f.client.events, []);
  await assert.rejects(fs.stat(f.savePath), { code: 'ENOENT' });
});

test('verification failure remains paused and retries journal state after the entire cache disappears', async t => {
  const f = await fixture(t);
  f.client.failVerification = true;
  let report = await f.run();
  assert.equal(report.imported, 0); assert.equal(report.errors[0].code, 'VERIFY_FAILED');
  assert.equal(f.client.live.paused, true); assert.equal(f.client.events.some(e => e.action === 'resume'), false);
  assert.equal(JSON.parse(await fs.readFile(await f.journalPath(), 'utf8')).phase, 'verifying');
  await fs.rm(f.config.cacheDir, { recursive: true, force: true });
  f.client.failVerification = false; f.client.events.length = 0;
  report = await f.run();
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.equal(f.client.events.some(e => e.action === 'addPaused'), false);
  assert.equal(f.client.live.paused, false);
});

test('lost successful add response reports AMBIGUOUS_ADD on retry without touching the live torrent', async t => {
  const f = await fixture(t);
  f.client.loseAddResponse = true;
  assert.equal((await f.run()).imported, 0);
  assert.equal(f.client.live.paused, true);
  f.client.events.length = 0;
  const report = await f.run();
  assert.ok(report.errors.some(error => error.hash === f.hash && error.code === 'AMBIGUOUS_ADD'));
  assert.deepEqual(f.client.events, []);
});

test('incremental import preserves a user-paused torrent', async t => {
  const f = await fixture(t);
  await f.run();
  f.client.live.paused = true;
  await fs.writeFile(path.join(f.source, 'bitfield'), Buffer.from([0xf0]));
  f.client.events.length = 0;
  const report = await f.run();
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.equal(f.client.live.paused, true);
  assert.equal(f.client.events.some(e => e.action === 'resume'), false);
});

test('changed ownership marker rejects further transfer before any torrent mutation', async t => {
  const f = await fixture(t);
  await f.run();
  f.client.live.marker = 'different-owner';
  await fs.writeFile(path.join(f.source, 'bitfield'), Buffer.from([0xf0]));
  f.client.events.length = 0;
  const report = await f.run();
  assert.equal(report.imported, 0);
  assert.ok(report.errors.some(error => error.code === 'OWNERSHIP_CHANGED'));
  assert.deepEqual(f.client.events, []);
  assert.equal((await fs.stat(path.join(f.savePath, 'Season/episode2.mkv'))).size, 3);
});

test('shared-write hardlinks refuse incremental merge and the preserved snapshot can retry after cache eviction', async t => {
  const f = await fixture(t);
  await f.run();
  const external = path.join(f.temp, 'external-library.mkv');
  const first = path.join(f.savePath, 'Season/episode1.mkv');
  await fs.link(first, external);
  await fs.writeFile(path.join(f.source, 'bitfield'), Buffer.from([0xf0]));
  f.client.events.length = 0;
  let report = await f.run();
  assert.ok(report.errors.some(error => error.code === 'UNSAFE_DESTINATION'));
  assert.equal(f.client.live.paused, true);
  assert.equal(f.client.events.some(e => e.action === 'resume'), false);
  assert.deepEqual(await fs.readFile(external), f.contents[1]);
  await fs.unlink(external);
  await fs.rm(f.config.cacheDir, { recursive: true, force: true });
  report = await f.run();
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(await fs.readFile(first), f.contents[1]);
});

test('malformed unrelated journal does not prevent healthy candidate transfer', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.config.destinationDir);
  const journalDir = path.dirname(await f.journalPath());
  await fs.mkdir(journalDir, { recursive: true });
  const brokenHash = 'a'.repeat(40);
  await fs.writeFile(path.join(journalDir, `${brokenHash}.json`), '{broken');
  const report = await f.run();
  assert.equal(report.imported, 1);
  assert.ok(report.errors.some(error => error.hash === brokenHash && error.code === 'INVALID_STATE'));
});

test('interruption immediately after snapshot move recovers without adopting unrelated folders', async t => {
  const f = await fixture(t);
  const originalRename = fs.rename;
  let interrupted = false;
  fs.rename = async (from, to) => {
    const result = await originalRename(from, to);
    if (path.basename(to) === f.hash && String(from).includes('.seme-staging')) {
      interrupted = true;
      const error = new Error('Simulated interruption after rename'); error.code = 'INTERRUPTED'; throw error;
    }
    return result;
  };
  try { assert.equal((await f.run()).imported, 0); }
  finally { fs.rename = originalRename; }
  assert.equal(interrupted, true);
  assert.equal(f.client.live, null);
  assert.equal(JSON.parse(await fs.readFile(await f.journalPath(), 'utf8')).phase, 'moving');
  await fs.rm(f.config.cacheDir, { recursive: true, force: true });
  const report = await f.run();
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.equal(f.client.events.filter(e => e.action === 'addPaused').length, 1);
});

test('new episode selection exposes client partial-file suffixes before merge and both storage layouts verify', async t => {
  for (const suffix of ['.part', '.!qB']) {
    await t.test(suffix, async t => {
      const f = await fixture(t);
      assert.equal((await f.run()).imported, 1);
      const original = 'Season/episode2.mkv';
      const alternate = original + suffix;
      await fs.rename(path.join(f.savePath, original), path.join(f.savePath, alternate));
      await fs.writeFile(path.join(f.source, 'bitfield'), Buffer.from([0xf0]));
      const select = f.client.select.bind(f.client);
      f.client.select = async (hash, selected, files) => {
        await select(hash, selected, files);
        assert.ok(selected.includes(2), 'the newly completed episode is selected before storage discovery');
        f.client.live.files[2].storagePaths = [original, alternate];
      };
      const waitVerified = f.client.waitVerified.bind(f.client);
      f.client.waitVerified = async (hash, selected, options) => {
        assert.deepEqual(await fs.readFile(path.join(f.savePath, alternate)), f.contents[2], 'client partial path must be complete before verification/resume');
        return waitVerified(hash, selected, options);
      };
      f.client.events.length = 0;
      const report = await f.run();
      assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
      assert.deepEqual(f.client.events.find(event => event.action === 'select').selected, [1, 2]);
      assert.deepEqual(await fs.readFile(path.join(f.savePath, original)), f.contents[2]);
      assert.deepEqual(await fs.readFile(path.join(f.savePath, 'Season/episode1.mkv')), f.contents[1]);
      assert.equal(f.client.live.paused, false);
    });
  }
});

test('known post-add setup failure preserves ownership in a manual phase and subsequent scans perform no mutations', async t => {
  const f = await fixture(t);
  f.client.failAddedSetup = true;
  let report = await f.run();
  assert.equal(report.imported, 0);
  assert.ok(report.errors.some(error => error.code === 'ADDED_SETUP_FAILED'));
  let job = JSON.parse(await fs.readFile(await f.journalPath(), 'utf8'));
  assert.equal(job.added, true);
  assert.equal(job.marker, f.client.live.marker);
  assert.equal(job.phase, 'setup-failed');
  assert.ok(job.pending);
  assert.equal(f.client.live.paused, true);
  assert.deepEqual(f.client.events.map(event => event.action), ['addPaused']);
  await fs.rm(f.config.cacheDir, { recursive: true, force: true });
  f.client.failAddedSetup = false;
  f.client.events.length = 0;
  report = await f.run();
  assert.equal(report.imported, 0);
  assert.ok(report.errors.some(error => error.code === 'ADDED_SETUP_FAILED'));
  assert.deepEqual(f.client.events, []);
  job = JSON.parse(await fs.readFile(await f.journalPath(), 'utf8'));
  assert.equal(job.phase, 'setup-failed');
  assert.equal(job.added, true);
});

test('separate incomplete directory preflight rejects before staging, export or client add', async t => {
  const f = await fixture(t);
  f.client.test = async () => {
    f.client.events.push({ action: 'test' });
    return { type: 'qbittorrent', storage: { separateIncompleteDirectory: true } };
  };
  const actualCache = require('../lib/cache.cjs');
  let exports = 0;
  const report = await scan(f.config, { stateDir: f.stateDir, client: f.client, cache: {
    discover: actualCache.discover,
    exportCandidate: (...args) => { exports++; return actualCache.exportCandidate(...args); }
  } });
  assert.equal(report.imported, 0);
  assert.ok(report.errors.some(error => error.code === 'UNSUPPORTED_STORAGE'));
  assert.equal(exports, 0);
  assert.equal(f.client.live, null);
  assert.deepEqual(f.client.events, [{ action: 'test' }]);
  await assert.rejects(fs.stat(f.savePath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.config.destinationDir, '.seme-staging')), { code: 'ENOENT' });
});

test('expired metadata-only caches are skipped without hiding real cache errors', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, 'bitfield'));
  let report = await f.run();
  assert.equal(report.imported, 0);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(f.client.events, []);
  await fs.writeFile(path.join(f.source, 'bitfield'), Buffer.from([0xff]));
  await fs.writeFile(path.join(f.source, 'cache'), 'invalid bencode');
  report = await f.run();
  assert.ok(report.errors.some(error => error.code === 'CACHE_UNAVAILABLE'));
  assert.deepEqual(f.client.events, []);
});
