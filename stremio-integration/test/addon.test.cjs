'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { start, DEFAULT_PORT, MANIFEST_ID, VERSION } = require('../lib/addon.cjs');
const { saveConfig, loadConfig } = require('../lib/config.cjs');

async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seme-addon-test-'));
  const file = path.join(dir, 'config.json');
  await saveConfig({ cacheDir: path.join(dir, 'cache'), destinationDir: path.join(dir, 'preserved'),
    minFreeBytes: 42, futureSetting: { retained: true },
    client: { type: 'transmission', url: 'http://127.0.0.1:9091/transmission/rpc', username: 'alice', password: 'private-secret-123', futureClientField: 'retained' }, ...extra }, file);
  const addon = start({ configFile: file, port: 0 });
  const ready = await addon.ready;
  t.after(async () => { await addon.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { ...ready, dir, file, addon };
}

function request(endpoint, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request(endpoint.url + pathname, { method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function form(endpoint, extra = {}) {
  const page = await request(endpoint, '/configure');
  const csrf = page.body.match(/name="csrf" value="([a-f0-9]{64})"/)[1];
  const config = await loadConfig(endpoint.file);
  return new URLSearchParams({ csrf, enabled: '1', clientType: config.client.type, clientUrl: config.client.url,
    username: config.client.username, password: '', cacheDir: config.cacheDir, destinationDir: config.destinationDir, ...extra }).toString();
}

function post(endpoint, body, headers = {}) {
  return request(endpoint, '/configure', { method: 'POST', body, headers: { Origin: endpoint.url, 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
}

test('loopback manifest is configurable, minimal and does not add homepage catalogs', async t => {
  const endpoint = await fixture(t);
  assert.equal(DEFAULT_PORT, 17881);
  const response = await request(endpoint, '/manifest.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  const manifest = JSON.parse(response.body);
  assert.equal(manifest.id, MANIFEST_ID);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.name, 'Sème');
  assert.deepEqual(manifest.behaviorHints, { configurable: true, configurationRequired: false });
  assert.deepEqual(manifest.catalogs, []);
  assert.deepEqual(manifest.resources, ['meta']);
  assert.deepEqual(manifest.types, ['other']);
  assert.deepEqual(manifest.idPrefixes, ['seme:']);
  assert.equal(response.body.includes('private-secret'), false);
  const meta = await request(endpoint, '/meta/other/seme:test.json');
  assert.equal(meta.status, 200);
  assert.equal(meta.headers['access-control-allow-origin'], '*');
  assert.deepEqual(JSON.parse(meta.body), { meta: null });
  assert.equal((await request(endpoint, '/catalog/other/seme.json')).status, 404);
});

test('configuration page escapes fields, never renders passwords and explains removal', async t => {
  const endpoint = await fixture(t, { client: { type: 'transmission', url: 'http://localhost:9091', username: '\"><script>bad()</script>', password: 'private-secret-123' } });
  const response = await request(endpoint, '/configure/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'same-origin');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.body, /&quot;&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(response.body, /<script>|private-secret-123/);
  assert.match(response.body, /name="password" type="password" value=""/);
  assert.match(response.body, /Désinstaller.*seulement cet addon visible/);
  assert.match(response.body, /fermez Stremio/);
  assert.match(response.body, /redémarrez Stremio/);
});

test('saving preserves blank passwords and unknown fields; explicit replacement and clearing work', async t => {
  const endpoint = await fixture(t);
  let response = await post(endpoint, await form(endpoint, { username: 'bob' }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/configure?saved=1');
  let saved = await loadConfig(endpoint.file);
  assert.equal(saved.client.password, 'private-secret-123');
  assert.equal(saved.client.username, 'bob');
  assert.equal(saved.client.futureClientField, 'retained');
  assert.deepEqual(saved.futureSetting, { retained: true });
  assert.equal(saved.minFreeBytes, 42);
  response = await post(endpoint, await form(endpoint, { password: 'replacement-secret' }));
  assert.equal(response.status, 303);
  assert.equal((await loadConfig(endpoint.file)).client.password, 'replacement-secret');
  assert.doesNotMatch((await request(endpoint, '/configure?saved=1')).body, /replacement-secret/);
  assert.match((await request(endpoint, '/configure?saved=1')).body, /Réglages enregistrés/);
  response = await post(endpoint, await form(endpoint, { clearPassword: '1' }));
  assert.equal(response.status, 303);
  assert.equal((await loadConfig(endpoint.file)).client.password, '');
  const disabled = new URLSearchParams(await form(endpoint)); disabled.delete('enabled');
  assert.equal((await post(endpoint, disabled.toString())).status, 303);
  assert.equal((await loadConfig(endpoint.file)).enabled, false);
});

test('configuration rejects unsafe hosts, origins and CSRF without changing settings', async t => {
  const endpoint = await fixture(t);
  const body = await form(endpoint, { username: 'unwanted-change' });
  for (const headers of [{ Host: 'evil.test' }, { Host: `localhost:${endpoint.port}` }, { Origin: 'https://evil.test' }, { Origin: 'null' }, { Origin: '' }]) {
    assert.equal((await post(endpoint, body, headers)).status, 403);
  }
  assert.equal((await request(endpoint, '/configure', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
  assert.equal((await post(endpoint, body.replace(/csrf=[^&]+/, 'csrf=invalid'))).status, 403);
  assert.equal((await request(endpoint, '/configure', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await post(endpoint, body, { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await post(endpoint, body + '&username=duplicate')).status, 400);
  assert.equal((await loadConfig(endpoint.file)).client.username, 'alice');
});

test('body bounds and client URL validation return safe errors', async t => {
  const endpoint = await fixture(t);
  const body = await form(endpoint);
  assert.equal((await post(endpoint, body + '&padding=' + 'a'.repeat(40000))).status, 413);
  assert.equal((await post(endpoint, body + '&padding=' + 'a'.repeat(40000), { 'Content-Length': Buffer.byteLength(body) + 40009 })).status, 413);
  const response = await post(endpoint, await form(endpoint, { clientUrl: 'http://secret:private@evil.test' }));
  assert.equal(response.status, 400);
  assert.doesNotMatch(response.body, /secret|private|evil\.test/);
  assert.match((await loadConfig(endpoint.file)).client.url, /127\.0\.0\.1/);
});

test('runtime status exposes only validated dates, counts and safe error labels', async t => {
  const endpoint = await fixture(t);
  const statusFile = path.join(endpoint.dir, 'status.json');
  await fs.writeFile(statusFile, JSON.stringify({ lastScan: '2026-11-15T12:34:56.000Z', imported: 3,
    errors: [{ code: 'ECONNREFUSED', message: 'private-secret-123' }] }));
  let response = await request(endpoint, '/configure');
  assert.match(response.body, /2026-11-15 12:34:56 UTC/);
  assert.match(response.body, /3 transfert\(s\) lors de cette analyse/);
  assert.match(response.body, /Client torrent injoignable/);
  assert.doesNotMatch(response.body, /private-secret/);
  await fs.writeFile(statusFile, JSON.stringify({ lastScan: '<script>secret</script>', imported: '<secret>', errors: [{ code: '<script>secret</script>', message: 'private-secret' }] }));
  response = await request(endpoint, '/configure');
  assert.doesNotMatch(response.body, /<script>|private-secret|&lt;secret&gt;/);
  assert.match(response.body, /Aucune analyse récente/);
  await fs.writeFile(statusFile, '{bad-private-secret');
  assert.doesNotMatch((await request(endpoint, '/configure')).body, /bad-private-secret/);
});

test('missing config is configurable, malformed config is never overwritten', async t => {
  const endpoint = await fixture(t);
  await fs.unlink(endpoint.file);
  const response = await request(endpoint, '/configure');
  assert.equal(response.status, 200);
  assert.match(response.body, /Enregistrez vos réglages/);
  await fs.writeFile(endpoint.file, 'private-secret-invalid-json');
  const body = new URLSearchParams({ csrf: response.body.match(/name="csrf" value="([a-f0-9]{64})"/)[1] }).toString();
  const rejected = await post(endpoint, body);
  assert.equal(rejected.status, 400);
  assert.doesNotMatch(rejected.body, /private-secret/);
  assert.equal(await fs.readFile(endpoint.file, 'utf8'), 'private-secret-invalid-json');
});

test('port conflicts reject readiness gracefully and stopping is idempotent', async t => {
  const endpoint = await fixture(t);
  const conflict = start({ configFile: endpoint.file, port: endpoint.port });
  await assert.rejects(conflict.ready, { code: 'EADDRINUSE' });
  await conflict.stop();
  await conflict.stop();
  assert.equal((await request(endpoint, '/manifest.json')).status, 200);
  await endpoint.addon.stop();
  await endpoint.addon.stop();
});

test('public addon routes allow CORS and private-network preflight without exposing configuration', async t => {
  const endpoint = await fixture(t);
  for (const route of ['/manifest.json', '/meta/other/seme:test.json']) {
    const response = await request(endpoint, route, { method: 'OPTIONS', headers: { Origin: 'https://web.stremio.com',
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.equal(response.headers['access-control-allow-private-network'], 'true');
    assert.equal(response.body, '');
  }
  const plain = await request(endpoint, '/manifest.json', { method: 'OPTIONS' });
  assert.equal(plain.headers['access-control-allow-private-network'], undefined);
  const configuration = await request(endpoint, '/configure', { method: 'OPTIONS', headers: { Origin: 'https://web.stremio.com' } });
  assert.equal(configuration.status, 403);
  assert.equal(configuration.headers['access-control-allow-origin'], undefined);
  assert.equal(configuration.headers['access-control-allow-private-network'], undefined);
});
