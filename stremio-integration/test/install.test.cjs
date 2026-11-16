'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const installer = require('../lib/install.cjs');

async function fixture(t, content) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'seme-install-test-'));
  const root = await fs.realpath(temporary);
  if (t.after) t.after(() => fs.rm(root, { recursive: true, force: true }));
  else process.once('exit', () => require('node:fs').rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'server.js');
  const sourceDir = path.join(root, 'source');
  await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir, 'index.cjs'), 'global.__semeFixture = true;\n');
  await fs.mkdir(path.join(sourceDir, 'test'));
  await fs.writeFile(path.join(sourceDir, 'test', 'excluded.cjs'), 'throw new Error("test");');
  const original = content || Buffer.from('#!/usr/bin/env node\r\n// original\nmodule.exports = "Stremio";\n\0\xff', 'latin1');
  await fs.writeFile(server, original, { mode: 0o751 });
  return { server, configFile: path.join(root, 'private', 'config.json'), sourceDir, processProbe: async () => false, original, root };
}

test('installation preserves shebang, exact bytes, mode and private backup; repeated install and uninstall are safe', async t => {
  const f = await fixture(t);
  assert.equal((await installer.status(f)).state, 'not-installed');
  const first = await installer.install(f);
  assert.equal(first.state, 'installed');
  const patched = await fs.readFile(f.server);
  assert.ok(patched.subarray(0, 20).equals(f.original.subarray(0, 20)));
  assert.equal(patched.toString().split(installer.BEGIN).length - 1, 1);
  assert.equal((await fs.stat(f.server)).mode & 0o777, 0o751);
  const loc = installer.locations(f.server, f.configFile);
  const manifest = JSON.parse(await fs.readFile(path.join(loc.state, 'manifest.json')));
  assert.equal(manifest.originalHash, installer.hash(f.original));
  assert.equal(manifest.patchedHash, installer.hash(patched));
  assert.deepEqual(await fs.readFile(path.join(loc.state, manifest.originalHash + '.original')), f.original);
  assert.equal((await fs.stat(path.join(loc.state, manifest.originalHash + '.original'))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(loc.module, 'test')));
  assert.equal((await installer.install(f)).unchanged, true);
  assert.deepEqual(await fs.readFile(f.server), patched);
  assert.equal((await installer.uninstall(f)).state, 'restored');
  assert.deepEqual(await fs.readFile(f.server), f.original);
  assert.equal((await fs.stat(f.server)).mode & 0o777, 0o751);
  assert.equal((await installer.uninstall(f)).unchanged, true);
});

test('modified patch cannot be overwritten by uninstall or reinstall', async t => {
  const f = await fixture(t);
  await installer.install(f);
  await fs.appendFile(f.server, '\n// unknown edit');
  const edited = await fs.readFile(f.server);
  assert.equal((await installer.status(f)).state, 'changed');
  await assert.rejects(installer.uninstall(f), /stale backup/);
  await assert.rejects(installer.install(f), /changed since installation/);
  await assert.rejects(installer.install({ ...f, acceptUpdate: true }), /still contains a Sème hook/);
  assert.deepEqual(await fs.readFile(f.server), edited);
});

test('orphaned exact hook recovery retains server bytes and config, snapshots the patch, and restores reconstructed bytes', async t => {
  const f = await fixture(t);
  const loc = installer.locations(f.server, f.configFile);
  const patched = installer.patch(f.original, path.join(loc.module, 'index.cjs'), f.configFile);
  await fs.writeFile(f.server, patched);
  await fs.mkdir(path.dirname(f.configFile), { recursive: true });
  const config = Buffer.from('{ "password": "keep exact config bytes" }\n');
  await fs.writeFile(f.configFile, config, { mode: 0o600 });
  const before = await fs.stat(f.server);
  assert.equal((await installer.status(f)).state, 'recoverable-hook');
  const result = await installer.install(f);
  assert.equal(result.state, 'installed');
  assert.equal(result.recovered, true);
  assert.deepEqual(await fs.readFile(f.server), patched);
  assert.equal((await fs.stat(f.server)).ino, before.ino);
  assert.equal((await fs.stat(f.server)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(f.configFile), config);
  assert.equal((await fs.stat(f.configFile)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(loc.module, 'index.cjs'), 'utf8'), 'global.__semeFixture = true;\n');
  const manifest = JSON.parse(await fs.readFile(path.join(loc.state, 'manifest.json')));
  assert.equal(manifest.originalSource, 'reconstructed-unhooked');
  assert.equal(manifest.recovery.method, 'removed-exact-current-hook');
  assert.equal(manifest.recovery.verifiedVendorOriginal, false);
  assert.equal(manifest.recovery.snapshotHash, installer.hash(patched));
  assert.deepEqual(await fs.readFile(path.join(loc.state, manifest.recovery.snapshot)), patched);
  assert.equal((await fs.stat(path.join(loc.state, manifest.recovery.snapshot))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(path.join(loc.state, manifest.originalHash + '.original')), f.original);
  assert.equal((await installer.install(f)).unchanged, true);
  assert.equal((await installer.uninstall(f)).state, 'restored');
  assert.deepEqual(await fs.readFile(f.server), f.original);
});

test('recovery recognizes canonical placement with or without shebang and preserves arbitrary body bytes', async t => {
  for (const original of [Buffer.from('// upstream\n\0\xff', 'latin1'), Buffer.from('#!/usr/bin/env node\n// upstream\n'), Buffer.from('#!/usr/bin/env node\r\n// upstream\r\n')]) {
    const f = await fixture(t, original);
    const loc = installer.locations(f.server, f.configFile);
    const patched = installer.patch(original, path.join(loc.module, 'index.cjs'), f.configFile);
    await fs.writeFile(f.server, patched);
    assert.equal((await installer.status(f)).state, 'recoverable-hook');
    await installer.install(f);
    await installer.uninstall(f);
    assert.deepEqual(await fs.readFile(f.server), original);
  }
});

test('orphan recovery rejects altered code, paths, markers, duplicate hooks and displaced hooks', async t => {
  const f = await fixture(t);
  const loc = installer.locations(f.server, f.configFile);
  const hook = installer.patch(Buffer.alloc(0), path.join(loc.module, 'index.cjs'), f.configFile);
  const body = Buffer.from('// upstream body\n');
  const variants = [
    Buffer.concat([Buffer.from(hook.toString().replace('try {', 'try  {')), body]),
    installer.patch(body, path.join(loc.module, 'elsewhere.cjs'), f.configFile),
    installer.patch(body, path.join(loc.module, 'index.cjs'), f.configFile + '.other'),
    Buffer.concat([Buffer.from(hook.toString().replace(installer.END, installer.END + ' altered')), body]),
    Buffer.concat([Buffer.from(hook.toString().replace('v1', 'v2')), body]),
    Buffer.concat([hook, hook, body]),
    Buffer.concat([body, hook]),
    Buffer.concat([hook, Buffer.from('#!/usr/bin/env node\n'), body]),
    Buffer.concat([hook, body, Buffer.from('// BEGIN SEME STREMIO INTEGRATION v2\n')]),
    Buffer.from(installer.END + '\n')
  ];
  for (const bytes of variants) {
    await fs.writeFile(f.server, bytes);
    assert.equal((await installer.status(f)).state, 'unknown-hook');
    await assert.rejects(installer.install(f), /unrecognized/);
    await assert.rejects(installer.install({ ...f, acceptUpdate: true }), /unrecognized/);
    assert.deepEqual(await fs.readFile(f.server), bytes);
    await assert.rejects(fs.stat(path.join(loc.state, 'manifest.json')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(loc.module), { code: 'ENOENT' });
  }
});

test('orphan recovery still requires an available process check and a stopped Stremio server', async t => {
  const f = await fixture(t);
  const loc = installer.locations(f.server, f.configFile);
  const patched = installer.patch(f.original, path.join(loc.module, 'index.cjs'), f.configFile);
  await fs.writeFile(f.server, patched);
  await assert.rejects(installer.install({ ...f, processProbe: async () => true }), /Quit Stremio/);
  await assert.rejects(installer.install({ ...f, processProbe: async () => { throw new Error('unavailable'); } }), /Cannot check Stremio processes/);
  assert.deepEqual(await fs.readFile(f.server), patched);
  await assert.rejects(fs.stat(loc.module), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(loc.state, 'manifest.json')), { code: 'ENOENT' });
});

test('an existing changed manifest cannot be replaced by orphan recovery even when the new hook is exact', async t => {
  const f = await fixture(t);
  await installer.install(f);
  const loc = installer.locations(f.server, f.configFile);
  const manifest = await fs.readFile(path.join(loc.state, 'manifest.json'));
  const changed = installer.patch(Buffer.from('// changed upstream body\n'), path.join(loc.module, 'index.cjs'), f.configFile);
  await fs.writeFile(f.server, changed);
  assert.equal((await installer.status(f)).state, 'changed');
  await assert.rejects(installer.install(f), /changed since installation/);
  await assert.rejects(installer.install({ ...f, acceptUpdate: true }), /still contains a Sème hook/);
  assert.deepEqual(await fs.readFile(path.join(loc.state, 'manifest.json')), manifest);
  assert.deepEqual(await fs.readFile(f.server), changed);
});

test('recovered installs retain strict patched-file and reconstructed-backup checksum checks', async t => {
  const f = await fixture(t);
  const loc = installer.locations(f.server, f.configFile);
  const patched = installer.patch(f.original, path.join(loc.module, 'index.cjs'), f.configFile);
  await fs.writeFile(f.server, patched);
  await installer.install(f);
  await fs.appendFile(f.server, '// unknown edit\n');
  const changed = await fs.readFile(f.server);
  await assert.rejects(installer.uninstall(f), /stale backup/);
  assert.deepEqual(await fs.readFile(f.server), changed);
  await fs.writeFile(f.server, patched);
  await fs.writeFile(path.join(loc.state, installer.hash(f.original) + '.original'), 'tampered');
  await assert.rejects(installer.uninstall(f), /Backup checksum mismatch/);
  assert.deepEqual(await fs.readFile(f.server), patched);
});

test('a server changed after inspection is refused before recovery metadata or runtime refresh', async t => {
  const f = await fixture(t);
  const loc = installer.locations(f.server, f.configFile);
  const patched = installer.patch(f.original, path.join(loc.module, 'index.cjs'), f.configFile);
  await fs.writeFile(f.server, patched);
  const changed = Buffer.concat([patched, Buffer.from('// concurrent edit\n')]);
  await assert.rejects(installer.install({ ...f, processProbe: async () => { await fs.writeFile(f.server, changed); return false; } }), /changed during installation/);
  assert.deepEqual(await fs.readFile(f.server), changed);
  await assert.rejects(fs.stat(loc.module), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(loc.state, 'manifest.json')), { code: 'ENOENT' });
});

test('a corrupt preexisting recovery snapshot prevents runtime restoration and manifest creation', async t => {
  const f = await fixture(t);
  const loc = installer.locations(f.server, f.configFile);
  const patched = installer.patch(f.original, path.join(loc.module, 'index.cjs'), f.configFile);
  await fs.writeFile(f.server, patched);
  await fs.mkdir(loc.state, { recursive: true });
  await fs.writeFile(path.join(loc.state, installer.hash(patched) + '.recovery'), 'corrupt snapshot');
  await assert.rejects(installer.install(f), /Backup checksum mismatch/);
  assert.deepEqual(await fs.readFile(f.server), patched);
  await assert.rejects(fs.stat(loc.module), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(loc.state, 'manifest.json')), { code: 'ENOENT' });
});

test('known upstream update needs explicit adoption and restores the new upstream bytes', async t => {
  const f = await fixture(t);
  await installer.install(f);
  const update = Buffer.from('// new upstream version\nconsole.log("updated");\n');
  await fs.writeFile(f.server, update);
  await assert.rejects(installer.install(f), /changed since installation/);
  await assert.rejects(installer.uninstall(f), /stale backup/);
  await installer.install({ ...f, acceptUpdate: true });
  await installer.uninstall(f);
  assert.deepEqual(await fs.readFile(f.server), update);
  const loc = installer.locations(f.server, f.configFile);
  assert.deepEqual(await fs.readFile(path.join(loc.state, installer.hash(f.original) + '.original')), f.original);
});

test('backup tampering prevents rollback without changing the installed file', async t => {
  const f = await fixture(t);
  await installer.install(f);
  const patched = await fs.readFile(f.server);
  const loc = installer.locations(f.server, f.configFile);
  await fs.writeFile(path.join(loc.state, installer.hash(f.original) + '.original'), 'bad backup');
  await assert.rejects(installer.uninstall(f), /Backup checksum mismatch/);
  assert.deepEqual(await fs.readFile(f.server), patched);
});

test('symbolic links, nonregular files, unknown hooks and active servers are refused', async t => {
  const f = await fixture(t);
  const link = path.join(f.root, 'server-link.js'); await fs.symlink(f.server, link);
  await assert.rejects(installer.install({ ...f, server: link }), /regular file/);
  await assert.rejects(installer.install({ ...f, server: f.sourceDir }), /regular file/);
  await assert.rejects(installer.install({ ...f, processProbe: async () => true }), /Quit Stremio/);
  assert.deepEqual(await fs.readFile(f.server), f.original);
  await fs.writeFile(f.server, installer.BEGIN + '\nunknown');
  await assert.rejects(installer.install(f), /unrecognized/);
});

test('hook runs with the current Node runtime and tolerates a missing module', async t => {
  const original = Buffer.from('#!/usr/bin/env node\nconsole.log(global.__semeFixture === true ? "hook ran" : "server ran");\n');
  const f = await fixture(t, original);
  await installer.install(f);
  let result = spawnSync(process.execPath, [f.server], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'hook ran');
  await fs.rm(installer.locations(f.server, f.configFile).module, { recursive: true });
  result = spawnSync(process.execPath, [f.server], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'server ran');
  assert.equal(result.stderr.trim(), '[Seme] Integration could not start.');
});

test('CLI config roundtrip uses stdin and emits no credentials', async t => {
  const f = await fixture(t);
  const cli = path.resolve(__dirname, '..', 'cli.cjs');
  const config = { enabled: true, cacheDir: path.join(f.root, 'cache'), destinationDir: path.join(f.root, 'seeding'), minFreeBytes: 0, intervalSeconds: 30,
    client: { type: 'transmission', url: 'http://127.0.0.1:9091/transmission/rpc', username: 'fixture-user', password: 'secret-no-stdout' } };
  let result = spawnSync(process.execPath, [cli, 'configure', '--config', f.configFile], { input: JSON.stringify(config), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout); assert.equal(JSON.parse(result.stdout).ok, true);
  assert.ok(!result.stdout.includes('secret-no-stdout')); assert.ok(!result.stdout.includes('fixture-user'));
  assert.equal((await fs.stat(f.configFile)).mode & 0o777, 0o600);
  result = spawnSync(process.execPath, [cli, 'validate', '--config', f.configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout);
  result = spawnSync(process.execPath, [cli, 'test-client', '--config', f.configFile], { input: JSON.stringify({ ...config, client: { ...config.client, url: 'http://evil.example' } }), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.ok(!result.stdout.includes('secret-no-stdout'));
});

test('status diagnostics are bounded and never expose arbitrary error details', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.configFile), { recursive: true });
  await fs.writeFile(path.join(path.dirname(f.configFile), 'status.json'), JSON.stringify({ lastScan: '2026-11-15T12:00:00.000Z', imported: 3, skipped: 2, enabled: true,
    errors: [{ code: 'AMBIGUOUS_ADD', hash: 'a'.repeat(40), message: 'secret-no-stdout' }, { code: 'secret/password', hash: 'password', arbitrary: 'secret-no-stdout' }] }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'cli.cjs'), 'status', '--server', f.server, '--config', f.configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.runtime.imported, 3);
  assert.equal(response.runtime.lastScan, '2026-11-15T12:00:00.000Z');
  assert.equal(response.runtime.errors[0].code, 'AMBIGUOUS_ADD');
  assert.equal(response.runtime.errors[1].code, 'RUNTIME_ERROR');
  assert.ok(!result.stdout.includes('secret-no-stdout'));
  assert.ok(!result.stdout.includes('password'));
});

test('client test warns that a separate incomplete directory is unsupported', async t => {
  const f = await fixture(t);
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: 'success', arguments: { 'rpc-version': 17, version: '4.0', 'incomplete-dir-enabled': true } })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await require('../lib/config.cjs').saveConfig({ cacheDir: path.join(f.root, 'cache'), destinationDir: path.join(f.root, 'destination'), client: { type: 'transmission', url: 'http://127.0.0.1:' + server.address().port + '/transmission/rpc', username: '', password: 'secret-no-stdout' } }, f.configFile);
    const result = await new Promise((resolve, reject) => {
      const child = require('node:child_process').spawn(process.execPath, [path.resolve(__dirname, '..', 'cli.cjs'), 'test-client', '--config', f.configFile]);
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stdin.end(); child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.output).code, 'UNSUPPORTED_STORAGE');
    assert.match(JSON.parse(result.output).error, /separate incomplete folder/);
    assert.ok(!result.output.includes('secret-no-stdout'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
