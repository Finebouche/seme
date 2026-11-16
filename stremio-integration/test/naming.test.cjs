'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { destinationName, isDestinationName, isDestinationPath, chooseDestination } = require('../lib/naming.cjs');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seme-naming-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('readable names preserve Unicode and remove video extensions only for single files', () => {
  assert.equal(destinationName('Amélie – 東京 🎬.mkv', { singleFile: true }), 'Amélie – 東京 🎬');
  assert.equal(destinationName('Season.mkv'), 'Season.mkv');
  assert.equal(destinationName('../Show\\Name:<2026>?\0\n'), 'Show Name 2026');
  for (const name of ['', '.', '..', '.seme-staging', 'CON', 'con.mkv', 'LPT1', '\0/\\']) {
    const safe = destinationName(name);
    assert.ok(isDestinationName(safe), `${JSON.stringify(name)} -> ${safe}`);
    assert.notEqual(safe, '.seme-staging');
  }
  const long = destinationName('東京🎬'.repeat(100));
  assert.ok(Buffer.byteLength(long) <= 180);
  assert.ok(!long.includes('\uFFFD'));
  assert.equal(long, Buffer.from(long).toString('utf8'));
});

test('paths must be safe immediate children, including legacy hash paths', async t => {
  const root = await directory(t);
  assert.ok(isDestinationPath(root, path.join(root, 'a'.repeat(40))));
  assert.ok(isDestinationPath(root, path.join(root, 'Amélie 東京')));
  for (const candidate of [root, path.join(root, '.seme-staging'), path.join(root, '.hidden'), path.join(root, 'x', 'y'),
    `${root}/child/../name`, path.join(root, 'x'.repeat(181)), path.join(root, 'NUL'), path.join(root, 'x\\y')]) {
    assert.equal(isDestinationPath(root, candidate), false, candidate);
  }
});

test('collisions include files, symlinks, case and normalized Unicode; hash suffix extends deterministically', async t => {
  const root = await directory(t);
  const hash = '0123456789abcdef'.repeat(2) + '01234567';
  assert.equal(await chooseDestination(root, 'Amélie', hash), path.join(root, 'Amélie'));
  await fs.writeFile(path.join(root, 'AME\u0301LIE'), 'foreign');
  assert.equal(await chooseDestination(root, 'Amélie', hash), path.join(root, 'Amélie [01234567]'));
  await fs.symlink('/nonexistent', path.join(root, 'Amélie [01234567]'));
  assert.equal(await chooseDestination(root, 'Amélie', hash), path.join(root, 'Amélie [0123456789ab]'));
  await fs.mkdir(path.join(root, 'Amélie [0123456789ab]'));
  assert.equal(await chooseDestination(root, 'Amélie', hash), path.join(root, 'Amélie [0123456789abcdef]'));
  assert.equal(await fs.readFile(path.join(root, 'AME\u0301LIE'), 'utf8'), 'foreign');
  assert.equal((await fs.lstat(path.join(root, 'Amélie [01234567]'))).isSymbolicLink(), true);
});

test('suffixes stay within the UTF8 limit and full-hash collisions are rejected', async t => {
  const root = await directory(t);
  const hash = 'a'.repeat(40);
  const name = destinationName('東京'.repeat(50));
  await fs.mkdir(path.join(root, name));
  let selected;
  for (let length = 8; length <= 40; length += 4) {
    selected = await chooseDestination(root, name, hash);
    assert.ok(Buffer.byteLength(path.basename(selected)) <= 180);
    assert.ok(selected.endsWith(`[${hash.slice(0, length)}]`));
    await fs.mkdir(selected);
  }
  await assert.rejects(chooseDestination(root, name, hash), { code: 'DESTINATION_EXISTS' });
});
