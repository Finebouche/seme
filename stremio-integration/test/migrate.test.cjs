'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrate } = require('../lib/migrate.cjs');
const { identity } = require('../lib/runtime.cjs');
const { validateConfig } = require('../lib/config.cjs');
function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [encode(key), encode(value[key])]), Buffer.from('e')]);
}
async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'seme-migrate-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const config = validateConfig({ cacheDir: path.join(temp, 'cache'), destinationDir: path.join(temp, 'saved'), minFreeBytes: 0,
    client: { type: 'transmission', url: 'http://127.0.0.1:9091/transmission/rpc', username: 'secret-user', password: 'secret-password' } });
  const data = Buffer.from('movie data');
  const name = options.multi ? 'Season' : 'Movie.mkv';
  const info = encode({ name, 'piece length': data.length, pieces: crypto.createHash('sha1').update(data).digest(),
    ...(options.multi ? { files: [{ length: data.length, path: ['episode.mkv'] }] } : { length: data.length }) });
  const hash = crypto.createHash('sha1').update(info).digest('hex');
  const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
  const stateDir = path.join(temp, 'state'), journal = path.join(stateDir, identity(config));
  const from = path.join(config.destinationDir, hash), to = path.join(config.destinationDir, options.multi ? 'Season' : 'Movie');
  const relative = options.multi ? 'Season/episode.mkv' : name;
  await fs.mkdir(path.dirname(path.join(from, relative)), { recursive: true });
  await fs.writeFile(path.join(from, relative), data);
  await fs.mkdir(journal, { recursive: true });
  const ownerToken = 'b'.repeat(32);
  const owner = `.seme-owner-${ownerToken}.json`;
  await fs.writeFile(path.join(from, owner), JSON.stringify({ hash, token: ownerToken }));
  const job = { version: 1, hash, phase: 'ready', added: true, ownerToken, marker: 'seme-cache', savePath: from,
    files: [{ index: 0, path: relative, length: data.length }], selected: [0] };
  const jobPath = path.join(journal, `${hash}.json`);
  const save = () => fs.writeFile(jobPath, JSON.stringify(job));
  await save();
  await fs.writeFile(path.join(journal, `${hash}.torrent`), torrent);
  const client = new FakeClient(job, data, !!options.paused);
  const run = (apply = true) => migrate(config, { apply, client, stateDir, timeoutMs: 30, pollIntervalMs: 1 });
  return { temp, config, stateDir, journal, hash, from, to, data, relative, owner, job, jobPath, save, client, run,
    load: async () => JSON.parse(await fs.readFile(jobPath, 'utf8')) };
}
class FakeClient {
  constructor(job, data, paused) {
    this.events = []; this.data = data;
    this.live = { hash: job.hash, savePath: job.savePath, marker: job.marker, paused, checking: false, error: false,
      files: job.files.map(file => ({ ...file, completed: file.length })), raw: { file_stats: [{ wanted: true, priority: 1 }] } };
  }
  async inspect() { return structuredClone(this.live); }
  async pause() { this.events.push('pause'); this.live.paused = true; }
  async call(method, args) {
    assert.equal(method, 'torrent_set_location'); assert.equal(args.move, true);
    assert.deepEqual(args.ids, [this.live.hash]); assert.equal(this.live.paused, true);
    this.events.push('move');
    // Intent must be durable before Transmission is asked to move anything.
    if (this.onMove) await this.onMove();
    if (this.failBeforeMove) throw Object.assign(new Error('secret RPC text'), { code: 'RPC_FAILED' });
    const roots = new Set(this.live.files.map(file => file.path.split('/')[0]));
    for (const name of roots) await fs.rename(path.join(this.live.savePath, name), path.join(args.location, name));
    this.live.savePath = args.location;
    if (this.failAfterMove) throw Object.assign(new Error('secret lost response'), { code: 'RPC_FAILED' });
  }
  async verify() { this.events.push('verify'); assert.equal(this.live.paused, true); }
  async waitVerified(hash, selected) {
    this.events.push('verified'); assert.deepEqual(selected, [0]);
    if (this.failVerify) throw Object.assign(new Error('failed'), { code: 'VERIFY_FAILED' });
    assert.deepEqual(await fs.readFile(path.join(this.live.savePath, this.live.files[0].path)), this.data);
    return structuredClone(this.live);
  }
  async resume() {
    this.events.push('resume'); assert.equal(this.live.paused, true); this.live.paused = false;
    if (this.failResume) throw Object.assign(new Error('lost start response'), { code: 'RPC_FAILED' });
  }
}

test('preview reports readable paths without changing state, files, or client', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.jobPath);
  const report = await f.run(false);
  assert.deepEqual(report.errors, []); assert.equal(report.migrated, 0); assert.equal(report.preview, true);
  assert.deepEqual(report.plans, [{ hash: f.hash, name: 'Movie.mkv', from: f.from, to: f.to, status: 'preview' }]);
  assert.deepEqual(f.client.events, []); assert.deepEqual(await fs.readFile(f.jobPath), before);
  await assert.rejects(fs.stat(f.to), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('apply uses native move, verifies, persists readable path and resumes formerly running torrent', async t => {
  const f = await fixture(t);
  f.client.onMove = async () => {
    const job = await f.load(); assert.equal(job.relocation.phase, 'moving'); assert.equal(job.savePath, f.from);
    assert.equal((await fs.stat(f.to)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.to, f.owner), 'utf8')), { hash: f.hash, token: f.job.ownerToken });
  };
  const report = await f.run();
  assert.deepEqual(report.errors, []); assert.equal(report.migrated, 1);
  assert.deepEqual(f.client.events, ['pause', 'move', 'verify', 'verified', 'resume']);
  assert.equal(f.client.live.paused, false);
  const job = await f.load(); assert.equal(job.savePath, f.to); assert.equal(job.destinationName, 'Movie'); assert.equal(job.relocation, undefined);
  assert.deepEqual(job.selected, [0]); assert.deepEqual(f.client.live.raw.file_stats, [{ wanted: true, priority: 1 }]);
  assert.deepEqual(await fs.readFile(path.join(f.to, f.relative)), f.data);
  await assert.rejects(fs.stat(f.from), { code: 'ENOENT' });
  assert.ok(await fs.stat(path.join(f.to, f.owner)));
  assert.equal((await f.run()).skipped, 1);
});

test('manual pause and old unrelated leftovers survive multi-file migration', async t => {
  const f = await fixture(t, { paused: true, multi: true });
  await fs.writeFile(path.join(f.from, 'notes.txt'), 'keep me');
  assert.equal((await f.run()).migrated, 1);
  assert.deepEqual(f.client.events, ['pause', 'move', 'verify', 'verified']);
  assert.equal(f.client.live.paused, true);
  assert.equal(await fs.readFile(path.join(f.from, 'notes.txt'), 'utf8'), 'keep me');
  await assert.rejects(fs.stat(path.join(f.from, f.owner)), { code: 'ENOENT' });
});

test('existing files, folders and case-folded names are never overwritten', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.config.destinationDir, 'MOVIE'), 'unrelated');
  const report = await f.run();
  assert.deepEqual(report.errors, []); assert.equal(report.migrated, 1);
  const target = `${f.to} [${f.hash.slice(0, 8)}]`;
  assert.equal(report.plans[0].to, target);
  assert.equal(await fs.readFile(path.join(f.config.destinationDir, 'MOVIE'), 'utf8'), 'unrelated');
  assert.deepEqual(await fs.readFile(path.join(target, f.relative)), f.data);
});

test('foreign label, missing marker, altered layout and invalid ownership remain untouched', async t => {
  for (const alteration of ['label', 'marker', 'layout', 'token', 'selected', 'archive']) {
    await t.test(alteration, async t => {
      const f = await fixture(t);
      if (alteration === 'label') f.client.live.marker = null;
      if (alteration === 'marker') await fs.unlink(path.join(f.from, f.owner));
      if (alteration === 'layout') f.client.live.files[0].path = 'renamed.mkv';
      if (alteration === 'token') { f.job.ownerToken = '../invalid'; await f.save(); }
      if (alteration === 'selected') { f.job.selected = [2]; await f.save(); }
      if (alteration === 'archive') await fs.writeFile(path.join(f.journal, `${f.hash}.torrent`), 'bad metainfo');
      const before = await fs.readFile(f.jobPath);
      const report = await f.run();
      assert.equal(report.migrated, 0); assert.equal(report.errors.length, 1);
      assert.deepEqual(f.client.events, []); assert.deepEqual(await fs.readFile(f.jobPath), before);
      assert.deepEqual(await fs.readFile(path.join(f.from, f.relative)), f.data);
      await assert.rejects(fs.stat(f.to), { code: 'ENOENT' });
    });
  }
});

test('a failed move leaves paused durable intent and an ambiguous old location is never moved twice', async t => {
  const f = await fixture(t); f.client.failBeforeMove = true;
  const report = await f.run();
  assert.deepEqual(report.errors, [{ hash: f.hash, code: 'RPC_FAILED' }]);
  assert.equal(f.client.live.paused, true); assert.equal((await f.load()).relocation.phase, 'moving');
  f.client.failBeforeMove = false; f.client.events = [];
  const retry = await f.run();
  assert.deepEqual(retry.errors, [{ hash: f.hash, code: 'AMBIGUOUS_RELOCATION' }]);
  assert.deepEqual(f.client.events, ['pause', 'pause']);
  assert.deepEqual(await fs.readFile(path.join(f.from, f.relative)), f.data);
});

test('lost move response reconciles the observed target and retries verification without another move', async t => {
  const f = await fixture(t); f.client.failAfterMove = true;
  assert.equal((await f.run()).errors[0].code, 'RPC_FAILED');
  assert.equal(f.client.live.paused, true); assert.equal((await f.load()).relocation.phase, 'moving');
  f.client.failAfterMove = false; f.client.events = [];
  const retry = await f.run();
  assert.deepEqual(retry.errors, []); assert.equal(retry.migrated, 1);
  assert.deepEqual(f.client.events, ['pause', 'verify', 'verified', 'resume']);
  assert.equal((await f.load()).relocation, undefined);
});

test('failed verification and ambiguous resume stay paused and can be retried', async t => {
  for (const failure of ['failVerify', 'failResume']) {
    await t.test(failure, async t => {
      const f = await fixture(t); f.client[failure] = true;
      const report = await f.run(); assert.equal(report.errors.length, 1);
      assert.equal(f.client.live.paused, true); assert.ok((await f.load()).relocation);
      f.client[failure] = false; f.client.events = [];
      const retry = await f.run(); assert.deepEqual(retry.errors, []); assert.equal(retry.migrated, 1);
      assert.ok(!f.client.events.includes('move')); assert.equal(f.client.live.paused, false);
    });
  }
});

test('invalid relocation paths and symlinked payloads are rejected before any client mutation', async t => {
  for (const alteration of ['escape', 'relative', 'symlink', 'incomplete']) {
    await t.test(alteration, async t => {
      const f = await fixture(t);
      if (alteration === 'escape' || alteration === 'relative') {
        f.job.relocation = { version: 1, from: f.from, to: alteration === 'escape' ? path.join(f.temp, 'outside') : 'Movie', phase: 'prepared', wasRunning: true };
        await f.save();
      }
      if (alteration === 'symlink') {
        const external = path.join(f.temp, 'external'); await fs.writeFile(external, f.data);
        await fs.unlink(path.join(f.from, f.relative)); await fs.symlink(external, path.join(f.from, f.relative));
      }
      if (alteration === 'incomplete') await fs.truncate(path.join(f.from, f.relative), 2);
      const before = await fs.readFile(f.jobPath);
      const report = await f.run(); assert.equal(report.errors.length, 1); assert.equal(report.migrated, 0);
      assert.deepEqual(f.client.events, []); assert.deepEqual(await fs.readFile(f.jobPath), before);
    });
  }
});

test('apply shares the runtime lock and refuses unsupported clients', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.stateDir, 'transfer.lock'), JSON.stringify({ pid: process.pid, token: 'owned' }));
  assert.equal((await f.run()).busy, true); assert.deepEqual(f.client.events, []);
  await assert.rejects(migrate({ ...f.config, client: { ...f.config.client, type: 'qbittorrent' } }, { stateDir: f.stateDir }), { code: 'UNSUPPORTED_CLIENT' });
});
