'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { discover, exportCandidate } = require('../lib/cache.cjs');

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')]);
}

async function setup(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'seme-cache-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const cache = path.join(temporary, 'stremio-cache');
  const destination = path.join(temporary, 'destination');
  await fs.mkdir(cache); await fs.mkdir(destination);
  const contents = options.contents || [Buffer.from('abc'), Buffer.from('MOVIE!'), Buffer.from('NEXT!!'), Buffer.from('z')];
  const pieceLength = options.pieceLength || 4;
  const all = Buffer.concat(contents);
  const hashes = [];
  for (let i = 0; i < all.length; i += pieceLength) hashes.push(crypto.createHash('sha1').update(all.subarray(i, i + pieceLength)).digest());
  const info = options.info || (options.single ? { name: 'movie.mkv', length: all.length,
    'piece length': pieceLength, pieces: Buffer.concat(hashes) } : {
    name: 'Season', 'piece length': pieceLength, pieces: Buffer.concat(hashes),
    files: contents.map((data, index) => ({ length: data.length,
      path: [options.paths ? options.paths[index] : ['before.bin', 'movie.mkv', 'next.mkv', 'tail.bin'][index]] }))
  });
  const infoBytes = options.infoBytes || bencode(info);
  // The info slice deliberately need not use canonical dictionary ordering.
  const torrent = Buffer.concat([Buffer.from('d4:info'), infoBytes, Buffer.from('e')]);
  const hash = crypto.createHash('sha1').update(infoBytes).digest('hex');
  const source = path.join(cache, hash);
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'cache'), torrent);
  await fs.writeFile(path.join(source, 'bitfield'), options.bitfield || Buffer.from([0xe0]));
  const sourceFiles = options.single ? [all] : contents;
  for (let i = 0; i < sourceFiles.length; i++) {
    if (options.missing === i) continue;
    const handle = await fs.open(path.join(source, String(i)), 'wx');
    // Numbered cache files can be sparse, with only verified piece slices written.
    if (options.sparse && i === 2) {
      await handle.truncate(sourceFiles[i].length);
      await handle.write(sourceFiles[i].subarray(0, 3), 0, 3, 0);
    } else await handle.writeFile(sourceFiles[i]);
    await handle.close();
  }
  return { temporary, cache, destination, source, hash, torrent, contents, info };
}

test('discovers sparse numbered multifile cache and exports only complete videos and boundary bytes', async t => {
  const fixture = await setup(t, { sparse: true });
  const [candidate] = await discover(fixture.cache);
  assert.deepEqual(candidate.selected, [1]);
  assert.equal(candidate.files[1].offset, 3);
  assert.equal(candidate.files[1].path, 'Season/movie.mkv');
  const exported = await exportCandidate(candidate, fixture.destination, { minFreeBytes: 0 });
  assert.equal(exported.savePath, path.join(await fs.realpath(fixture.destination), fixture.hash));
  assert.deepEqual(exported.selected, [1]);
  assert.deepEqual(exported.files.map(f => f.ranges), [[{ start: 0, end: 3 }], [{ start: 0, end: 6 }], [{ start: 0, end: 3 }], []]);
  assert.deepEqual(await fs.readFile(path.join(exported.savePath, 'Season/movie.mkv')), fixture.contents[1]);
  assert.equal((await fs.stat(path.join(exported.savePath, 'Season/next.mkv'))).size, 3);
  await assert.rejects(fs.stat(path.join(exported.savePath, 'Season/tail.bin')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(fixture.source, '1')), fixture.contents[1]);
  assert.deepEqual(exported.torrent, fixture.torrent);
});

test('single-file cache retains the exact info bytes and original root filename', async t => {
  const contents = [Buffer.from('movie!!!')];
  const pieces = Buffer.concat([crypto.createHash('sha1').update(contents[0].subarray(0, 4)).digest(), crypto.createHash('sha1').update(contents[0].subarray(4)).digest()]);
  const infoBytes = Buffer.concat([Buffer.from('d4:name9:movie.mkv6:pieces40:'), pieces, Buffer.from('12:piece lengthi4e6:lengthi8ee')]);
  const fixture = await setup(t, { contents, single: true, infoBytes, bitfield: Buffer.from([0xc0]) });
  const [candidate] = await discover(fixture.cache);
  assert.equal(candidate.hash, fixture.hash);
  assert.deepEqual(candidate.selected, [0]);
  const exported = await exportCandidate(candidate, fixture.destination, { minFreeBytes: 0 });
  assert.deepEqual(await fs.readFile(path.join(exported.savePath, 'movie.mkv')), contents[0]);
  // Reflink and plain-copy paths must both isolate mutable torrent clients.
  await fs.writeFile(path.join(exported.savePath, 'movie.mkv'), 'changed!');
  assert.deepEqual(await fs.readFile(path.join(fixture.source, '0')), contents[0]);
});

test('selected subset exports only requested complete video and covering pieces', async t => {
  const fixture = await setup(t, { bitfield: Buffer.from([0xf0]) });
  const [candidate] = await discover(fixture.cache);
  assert.deepEqual(candidate.selected, [1, 2]);
  const exported = await exportCandidate(candidate, fixture.destination, { selected: [2], minFreeBytes: 0 });
  assert.deepEqual(exported.selected, [2]);
  assert.deepEqual(exported.files.map(f => f.ranges), [[], [{ start: 5, end: 6 }], [{ start: 0, end: 6 }], [{ start: 0, end: 1 }]]);
  const prefix = await fs.readFile(path.join(exported.savePath, 'Season/movie.mkv'));
  assert.deepEqual(prefix, Buffer.from([0, 0, 0, 0, 0, 33]));
});

test('incomplete bitfield, missing boundary file, and missing bitfield are skipped', async t => {
  const fixture = await setup(t, { bitfield: Buffer.from([0xc0]) });
  assert.deepEqual(await discover(fixture.cache), []);
  await fs.writeFile(path.join(fixture.source, 'bitfield'), Buffer.from([0xe0]));
  await fs.unlink(path.join(fixture.source, '2'));
  assert.deepEqual(await discover(fixture.cache), []);
  await fs.unlink(path.join(fixture.source, 'bitfield'));
  const errors = [];
  assert.deepEqual(await discover(fixture.cache, { onError: (error, hash) => errors.push([error, hash]) }), []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], fixture.hash);
});

test('bitfield bits use MSB numbering and final partial pieces verify', async t => {
  const fixture = await setup(t, { single: true, contents: [Buffer.from('abcde')], bitfield: Buffer.from([0xc0]) });
  const [candidate] = await discover(fixture.cache);
  await exportCandidate(candidate, fixture.destination, { minFreeBytes: 0 });
  await fs.writeFile(path.join(fixture.source, 'bitfield'), Buffer.from([0x03]));
  assert.deepEqual(await discover(fixture.cache), []);
});

test('stale completion bits cannot export corrupted bytes and failed export is removed', async t => {
  const fixture = await setup(t);
  const [candidate] = await discover(fixture.cache);
  await fs.writeFile(path.join(fixture.source, '1'), 'BROKEN');
  await assert.rejects(exportCandidate(candidate, fixture.destination, { minFreeBytes: 0 }), /SHA-1/);
  await assert.rejects(fs.stat(path.join(fixture.destination, fixture.hash)), { code: 'ENOENT' });
});

test('export revalidates current completion and refuses stale or invalid selections', async t => {
  const fixture = await setup(t);
  const [candidate] = await discover(fixture.cache);
  await assert.rejects(exportCandidate(candidate, fixture.destination, { selected: [2] }), /Selected/);
  await assert.rejects(exportCandidate(candidate, fixture.destination, { selected: [1, 1] }), /Selected/);
  await fs.writeFile(path.join(fixture.source, 'bitfield'), Buffer.from([0]));
  await assert.rejects(exportCandidate(candidate, fixture.destination), /Selected/);
});

test('existing export destination is always refused without touching client files', async t => {
  const fixture = await setup(t);
  const [candidate] = await discover(fixture.cache);
  const existing = path.join(fixture.destination, fixture.hash);
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'owned'), 'keep');
  await assert.rejects(exportCandidate(candidate, fixture.destination, { minFreeBytes: 0 }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(existing, 'owned'), 'utf8'), 'keep');
});

test('unsafe paths, duplicate/colliding names and v2-only metadata are rejected', async t => {
  for (const bad of ['..', '/escape.mkv', 'a\\b.mkv', 'C:escape.mkv', 'bad\0.mkv']) {
    const fixture = await setup(t, { paths: ['before.bin', bad, 'next.mkv', 'tail.bin'] });
    assert.deepEqual(await discover(fixture.cache), [], bad);
  }
  const collision = await setup(t, { paths: ['a.mkv', 'A.mkv', 'next.mkv', 'tail.bin'] });
  assert.deepEqual(await discover(collision.cache), []);
  const v2 = await setup(t, { info: { name: 'v2.mkv', length: 1, 'piece length': 4, 'meta version': 2 } });
  assert.deepEqual(await discover(v2.cache), []);
});

test('hash mismatches, unsafe numeric metadata, malformed bencode and bounded inputs are rejected', async t => {
  const fixture = await setup(t);
  await fs.rename(fixture.source, path.join(fixture.cache, 'a'.repeat(40)));
  assert.deepEqual(await discover(fixture.cache), []);
  for (const bytes of [Buffer.from('d4:name1:x6:lengthi9007199254740992ee'), Buffer.from('d1:ai01ee'), Buffer.from('d1:ai1e1:ai2ee'), Buffer.from('l'.repeat(40) + 'e'.repeat(40))]) {
    const invalid = await setup(t, { infoBytes: bytes });
    assert.deepEqual(await discover(invalid.cache), []);
  }
  const huge = await setup(t);
  await fs.truncate(path.join(huge.source, 'cache'), 17 * 1024 * 1024);
  assert.deepEqual(await discover(huge.cache), []);
});

test('symlink cache files, torrent directories and destinations are refused', async t => {
  const fixture = await setup(t);
  const [candidate] = await discover(fixture.cache);
  const unsafeDestination = path.join(fixture.temporary, 'alias');
  await fs.symlink(fixture.destination, unsafeDestination);
  await assert.rejects(exportCandidate(candidate, unsafeDestination), /Unsafe/);
  await assert.rejects(exportCandidate(candidate, path.join(unsafeDestination, 'nested')), /Unsafe/);
  assert.deepEqual(await fs.readdir(fixture.destination), []);
  await fs.rename(path.join(fixture.source, '1'), path.join(fixture.source, 'original'));
  await fs.symlink(path.join(fixture.source, 'original'), path.join(fixture.source, '1'));
  assert.deepEqual(await discover(fixture.cache), []);
  await fs.unlink(path.join(fixture.source, '1'));
  await fs.rename(path.join(fixture.source, 'original'), path.join(fixture.source, '1'));
  const moved = path.join(fixture.temporary, 'moved');
  await fs.rename(fixture.source, moved);
  await fs.symlink(moved, fixture.source);
  assert.deepEqual(await discover(fixture.cache), []);
  await assert.rejects(exportCandidate(candidate, fixture.destination), /Unsafe/);
});

test('insufficient disk budget and invalid free-space options fail before creating destination', async t => {
  const fixture = await setup(t);
  const [candidate] = await discover(fixture.cache);
  await assert.rejects(exportCandidate(candidate, fixture.destination, { minFreeBytes: Number.MAX_SAFE_INTEGER }), /Insufficient/);
  await assert.rejects(exportCandidate(candidate, fixture.destination, { minFreeBytes: -1 }), /Invalid/);
  assert.deepEqual(await fs.readdir(fixture.destination), []);
});

test('missing cache root is an empty discovery', async t => {
  const fixture = await setup(t);
  assert.deepEqual(await discover(path.join(fixture.temporary, 'missing')), []);
});
