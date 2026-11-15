'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateConfig, loadConfig, saveConfig, privateDirectory } = require('../lib/config.cjs');

function config(extra = {}) {
  return { cacheDir: path.join(os.tmpdir(), 'seme-config-test-cache'), destinationDir: path.join(os.tmpdir(), 'seme-config-test-preserved'),
    minFreeBytes: 0, client: { type: 'transmission', url: 'http://127.0.0.1:9091/transmission/rpc', username: 'alice', password: 'private-test-secret' }, ...extra };
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seme-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('configuration requires disjoint absolute cache/preservation directories', () => {
  for (const [cacheDir, destinationDir] of [['/same', '/same'], ['/cache', '/cache/child'], ['/destination/cache', '/destination'], ['relative', '/destination'], ['/cache', '/']]) {
    assert.throws(() => validateConfig(config({ cacheDir, destinationDir })));
  }
  assert.equal(validateConfig(config({ cacheDir: '/tmp/cache', destinationDir: '/tmp/cache-sibling' })).destinationDir, '/tmp/cache-sibling');
});

test('client endpoint must be loopback HTTP(S), credentials remain separate fields', () => {
  for (const url of ['http://example.com:9091', 'http://192.168.1.2:9091', 'file:///tmp/client', 'http://alice:secret@127.0.0.1:9091', 'http://127.0.0.1:9091/?secret=x', 'http://127.0.0.1:9091/#fragment']) {
    assert.throws(() => validateConfig(config({ client: { type: 'transmission', url } })), url);
  }
  for (const url of ['http://127.0.0.1:9091', 'https://localhost:8112', 'http://[::1]:8080']) {
    assert.ok(validateConfig(config({ client: { type: 'deluge', url, password: 'secret' } })).client.url);
  }
});

test('configuration validates selection of supported client, interval and free-space bounds', () => {
  for (const extra of [{ minFreeBytes: -1 }, { minFreeBytes: NaN }, { intervalSeconds: 1 }, { intervalSeconds: 3601 }, { enabled: 'true' }, { client: { type: 'unsupported' } }, { client: { password: 123 } }]) {
    assert.throws(() => validateConfig(config(extra)));
  }
});

test('saved credentials and replacement config use private 0600 files without temporary leftovers', async t => {
  const dir = await temporary(t);
  const filename = path.join(dir, 'private', 'config.json');
  const value = config();
  await saveConfig(value, filename);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
  assert.equal((await loadConfig(filename)).client.password, value.client.password);
  await fs.chmod(filename, 0o644);
  await saveConfig({ ...value, enabled: false }, filename);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal((await loadConfig(filename)).enabled, false);
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['config.json']);
});

test('config and private-state directory symlinks are refused, including symlink ancestors', async t => {
  const dir = await temporary(t);
  const real = path.join(dir, 'real');
  await fs.mkdir(real);
  const filename = path.join(real, 'config.json');
  await saveConfig(config(), filename);
  const alias = path.join(dir, 'alias.json');
  await fs.symlink(filename, alias);
  await assert.rejects(loadConfig(alias));
  await assert.rejects(saveConfig(config(), alias));
  const directoryAlias = path.join(dir, 'alias');
  await fs.symlink(real, directoryAlias);
  await assert.rejects(privateDirectory(directoryAlias));
  await assert.rejects(privateDirectory(path.join(directoryAlias, 'nested')));
  await assert.rejects(fs.stat(path.join(real, 'nested')), { code: 'ENOENT' });
});
