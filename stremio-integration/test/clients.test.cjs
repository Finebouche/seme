'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createClient } = require('../lib/clients.cjs');
const HASH = 'a'.repeat(40);
const FILES = [{ index: 0, path: 'movie.mkv', length: 2 * 1024 * 1024 + 123 }, { index: 1, path: 'extra.txt', length: 65536 }];
const ADD = { hash: HASH, torrent: Buffer.from('mock torrent'), savePath: '/seme/hash', selected: [0], files: FILES };
async function mock(t, handler) {
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    try { await handler(req, res, body); } catch (error) { res.statusCode = 500; res.end(); t.diagnostic(error.stack); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function send(res, value) { res.end(JSON.stringify(value)); }
function torrent(status = 0, complete = FILES[0].length) { return { hashString: HASH, downloadDir: ADD.savePath, labels: ['seme-cache'], status, error: 0, files: [{ name: 'movie.mkv', length: FILES[0].length, bytesCompleted: complete }, { name: 'extra.txt', length: FILES[1].length, bytesCompleted: 0 }] }; }

test('Transmission authenticates, retries session token, selects only desired files and verifies before resume', async t => {
  const calls = []; let added = false; let checking = 0;
  const url = await mock(t, (req, res, raw) => {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('user:secret').toString('base64'));
    if (req.headers['x-transmission-session-id'] !== 'session') { res.writeHead(409, { 'X-Transmission-Session-Id': 'session' }); res.end(); return; }
    const q = JSON.parse(raw); calls.push(q);
    let result = {};
    if (q.method === 'session-get') result = { 'rpc-version': 17, version: '4.0.6' };
    if (q.method === 'torrent-get') result = { torrents: added ? [torrent(checking > 0 ? (--checking, 2) : 0)] : [] };
    if (q.method === 'torrent-add') { added = true; result = { 'torrent-added': { hashString: HASH } }; }
    if (q.method === 'torrent-verify') checking = 2;
    send(res, { result: 'success', arguments: result });
  });
  const c = createClient({ type: 'transmission', url, username: 'user', password: 'secret', pollIntervalMs: 5 });
  assert.equal((await c.addPaused(ADD)).marker, 'seme-cache');
  const add = calls.find(c => c.method === 'torrent-add').arguments;
  assert.equal(add.paused, true); assert.deepEqual(add['files-unwanted'], [1]); assert.deepEqual(add['files-wanted'], [0]); assert.equal(add['download-dir'], ADD.savePath);
  const limits = calls.find(c => c.method === 'torrent-set').arguments;
  assert.equal(limits.seedRatioMode, 2); assert.equal(limits.seedIdleMode, 2);
  await assert.rejects(c.resume(HASH), /verification/);
  await c.verify(HASH); await c.waitVerified(HASH, [0], { timeoutMs: 100 }); await c.resume(HASH);
  assert.equal(calls.at(-1).method, 'torrent-start');
});

test('Transmission duplicate add races never apply limits, pause, select or resume', async t => {
  const calls = [];
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw); calls.push(q.method);
    const args = q.method === 'session-get' ? { 'rpc-version': 17 } : q.method === 'torrent-get' ? { torrents: [] } : { 'torrent-duplicate': { hashString: HASH } };
    send(res, { result: 'success', arguments: args });
  });
  const c = createClient({ type: 'transmission', url });
  await assert.rejects(c.addPaused(ADD), { code: 'DUPLICATE' });
  assert.deepEqual(calls, ['session-get', 'torrent-get', 'torrent-add']);
});

test('Transmission RPC18 uses native JSON-RPC snake_case after legacy discovery', async t => {
  const calls = [];
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw); calls.push(q);
    if (q.method === 'session-get') send(res, { result: 'success', arguments: { 'rpc-version': 18 } });
    else send(res, { jsonrpc: '2.0', id: 1, result: { torrents: [] } });
  });
  assert.equal(await createClient({ type: 'transmission', url }).inspect(HASH), null);
  assert.equal(calls[1].method, 'torrent_get'); assert.equal(calls[1].jsonrpc, '2.0'); assert.ok(calls[1].params.fields.includes('hash_string'));
});

test('verification refuses stale stopped snapshots, incomplete selected data, and resume after selection changes', async t => {
  let mode = 'stale';
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw);
    const args = q.method === 'session-get' ? { 'rpc-version': 17 } : q.method === 'torrent-get' ? { torrents: [torrent(mode === 'checking' ? 2 : 0, FILES[0].length - (mode === 'incomplete' ? 16384 : 0))] } : {};
    send(res, { result: 'success', arguments: args });
  });
  const c = createClient({ type: 'transmission', url, pollIntervalMs: 5 });
  await c.verify(HASH); await assert.rejects(c.waitVerified(HASH, [0], { timeoutMs: 20 }), /observably/);
  mode = 'checking'; await c.verify(HASH); mode = 'incomplete'; await assert.rejects(c.waitVerified(HASH, [0]), /failed verification/);
  await assert.rejects(c.resume(HASH), /verification/);
  mode = 'checking'; await c.verify(HASH); mode = 'complete'; await c.waitVerified(HASH, [0]);
  await c.select(HASH, [0, 1], FILES); await assert.rejects(c.resume(HASH), /verification/);
});

for (const api of ['2.8.0', '2.11.0']) test(`qBittorrent ${api} cookies, paused add, random ownership and correct start endpoint`, async t => {
  const calls = []; let tag; let added = false; let checks = 0; let logins = 0;
  const url = await mock(t, (req, res, raw) => {
    const name = req.url.split('/api/v2/')[1]; calls.push({ name, raw });
    if (name === 'auth/login') { logins++; assert.equal(new URLSearchParams(raw).get('password'), 'secret'); res.setHeader('Set-Cookie', 'SID=session; HttpOnly'); res.end('Ok.'); return; }
    assert.equal(req.headers.cookie, 'SID=session');
    if (name === 'app/webapiVersion') return res.end(api);
    if (name === 'app/preferences') return send(res, { temp_path_enabled: false });
    if (name === 'app/version') return res.end('v5.0.0');
    if (name === 'torrents/add') {
      assert.match(raw, /name="autoTMM"\r\n\r\nfalse/); assert.match(raw, /name="contentLayout"\r\n\r\nOriginal/); assert.match(raw, /name="stopped"\r\n\r\ntrue/);
      tag = raw.match(/seme-[a-f0-9]{32}/)[0]; added = true; return res.end('Ok.');
    }
    if (name === 'torrents/info') return send(res, added ? [{ hash: HASH, save_path: ADD.savePath, tags: tag, state: checks > 0 ? (--checks, 'checkingUP') : 'stoppedUP' }] : []);
    if (name === 'torrents/files') return send(res, FILES.map(f => ({ index: f.index, name: f.path, size: f.length, progress: f.index === 0 ? 1 : 0 })));
    if (name === 'torrents/recheck') checks = 2;
    res.end('');
  });
  const c = createClient({ type: 'qbittorrent', url, password: 'secret', pollIntervalMs: 5 });
  const result = await c.addPaused(ADD); assert.equal(result.marker, tag);
  assert.equal(logins, 1);
  const prios = calls.filter(c => c.name === 'torrents/filePrio').map(c => Object.fromEntries(new URLSearchParams(c.raw)));
  assert.deepEqual(prios.map(p => [p.id, p.priority]), [['1', '0'], ['0', '1']]);
  await c.verify(HASH); await c.waitVerified(HASH, [0]); await c.resume(HASH);
  assert.equal(calls.at(-1).name, api === '2.11.0' ? 'torrents/start' : 'torrents/resume');
});

test('qBittorrent race duplicate lacks random marker and receives no subsequent mutations', async t => {
  const calls = []; let added = false;
  const url = await mock(t, (req, res, raw) => {
    const name = req.url.split('/api/v2/')[1]; calls.push(name);
    if (name === 'auth/login') { res.setHeader('Set-Cookie', 'SID=s'); return res.end('Ok.'); }
    if (name === 'app/webapiVersion') return res.end('2.11.0');
    if (name === 'app/preferences') return send(res, { temp_path_enabled: false });
    if (name === 'app/version') return res.end('v5.0.0');
    if (name === 'torrents/add') { added = true; return res.end('Ok.'); }
    if (name === 'torrents/info') return send(res, added ? [{ hash: HASH, save_path: '/foreign', tags: '', state: 'uploading' }] : []);
    if (name === 'torrents/files') return send(res, []);
    throw new Error('Unexpected mutation ' + name);
  });
  await assert.rejects(createClient({ type: 'qbittorrent', url }).addPaused(ADD), { code: 'DUPLICATE' });
  assert.equal(calls.includes('torrents/filePrio'), false);
});

test('Deluge Web authenticates with cookie, atomically adds paused with selected priorities and seed policy', async t => {
  const calls = []; let added = false; let checks = 0;
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw); calls.push(q); let result = null;
    if (q.method === 'auth.login') { assert.deepEqual(q.params, ['secret']); res.setHeader('Set-Cookie', '_session_id=session'); result = true; }
    else {
      assert.equal(req.headers.cookie, '_session_id=session');
      if (q.method === 'web.connected') result = true;
      if (q.method === 'daemon.info') result = '2.1.1';
      if (q.method === 'core.add_torrent_file') { added = true; result = HASH; }
      if (q.method === 'core.force_recheck') checks = 2;
      if (q.method === 'core.get_torrent_status') result = added ? { save_path: ADD.savePath, paused: true, state: checks > 0 ? (--checks, 'Checking') : 'Paused', files: FILES.map(f => ({ index: f.index, path: f.path, size: f.length })), file_progress: [1, 0] } : {};
    }
    send(res, { id: q.id, result, error: null });
  });
  const c = createClient({ type: 'deluge', url, password: 'secret', pollIntervalMs: 5 });
  await c.test(); await c.addPaused(ADD);
  const opts = calls.find(c => c.method === 'core.add_torrent_file').params[2];
  assert.equal(opts.add_paused, true); assert.equal(opts.auto_managed, false); assert.equal(opts.stop_at_ratio, false); assert.equal(opts.remove_at_ratio, false); assert.deepEqual(opts.file_priorities, [1, 0]);
  await c.select(HASH, [0, 1], FILES);
  assert.deepEqual(calls.at(-1).params[1].file_priorities, [1, 1]);
  await c.verify(HASH); await c.waitVerified(HASH, [0]); await c.resume(HASH);
  assert.equal(calls.at(-1).method, 'core.resume_torrent');
});

for (const type of ['transmission', 'qbittorrent', 'deluge']) test(`${type} never echoes secrets in daemon failures`, async t => {
  const url = await mock(t, (req, res) => { res.statusCode = 401; res.end('password SECRET /private/path'); });
  const c = createClient({ type, url: url.replace('http://', 'http://USER:SECRET@'), password: 'SECRET' });
  await assert.rejects(c.test(), e => !/SECRET|USER|private/.test(e.message));
});

test('HTTP request timeout is bounded and invalid hash cannot target all torrents', async t => {
  const sockets = new Set();
  const url = await mock(t, (req, res) => { sockets.add(req.socket); req.socket.on('close', () => sockets.delete(req.socket)); });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const c = createClient({ type: 'transmission', url, requestTimeoutMs: 100 });
  await assert.rejects(c.inspect('all'), /Invalid torrent hash/);
  await assert.rejects(c.test(), /timed out/);
});

test('qBittorrent and Deluge reauthenticate expired sessions once', async t => {
  for (const type of ['qbittorrent', 'deluge']) {
    let logins = 0; let expired = false;
    const url = await mock(t, (req, res, raw) => {
      const q = type === 'deluge' ? JSON.parse(raw) : null;
      const login = type === 'deluge' ? q.method === 'auth.login' : req.url.endsWith('/auth/login');
      if (login) { logins++; res.setHeader('Set-Cookie', 'session=' + logins); return type === 'deluge' ? send(res, { result: true, error: null }) : res.end('Ok.'); }
      if (!expired) { expired = true; if (type === 'deluge') return send(res, { result: null, error: { code: 1, message: 'Not authenticated' } }); res.statusCode = 403; return res.end(); }
      if (type === 'deluge') return send(res, { result: q.method === 'web.connected' ? true : '2.1', error: null });
      if (req.url.endsWith('/preferences')) return send(res, { temp_path_enabled: false });
      res.end(req.url.endsWith('/webapiVersion') ? '2.11.0' : 'v5.0');
    });
    await createClient({ type, url }).test(); assert.equal(logins, 2);
  }
});

test('Deluge add errors never adopt or modify a raced duplicate', async t => {
  const calls = [];
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw); calls.push(q.method);
    if (q.method === 'auth.login') { res.setHeader('Set-Cookie', 'session=s'); return send(res, { result: true }); }
    if (q.method === 'core.get_torrent_status') return send(res, { result: {} });
    if (q.method === 'core.add_torrent_file') return send(res, { error: { code: 4, message: 'Torrent already in session SECRET' } });
    throw new Error('Unexpected mutation');
  });
  await assert.rejects(createClient({ type: 'deluge', url }).addPaused(ADD), e => e.code === 'RPC' && !e.message.includes('SECRET'));
  assert.deepEqual(calls, ['auth.login', 'core.get_torrent_status', 'core.add_torrent_file']);
});

test('inspect exposes relative client naming variants and excludes canonical-name collisions', async t => {
  for (const type of ['transmission', 'qbittorrent', 'deluge']) {
    const url = await mock(t, (req, res, raw) => {
      const q = type === 'qbittorrent' ? null : JSON.parse(raw);
      if (type === 'transmission') return send(res, { result: 'success', arguments: q.method === 'session-get' ? { 'rpc-version': 17 } : { torrents: [{ ...torrent(), files: [{ name: 'dir/movie', length: 65536, bytesCompleted: 65536 }, { name: 'dir/movie.part', length: 1, bytesCompleted: 1 }] }] } });
      if (type === 'deluge') {
        if (q.method === 'auth.login') { res.setHeader('Set-Cookie', 'session=s'); return send(res, { result: true }); }
        return send(res, { result: { save_path: ADD.savePath, paused: true, state: 'Paused', files: [{ path: 'dir/movie', size: 65536 }], file_progress: [1] } });
      }
      const name = req.url.split('/api/v2/')[1];
      if (name === 'auth/login') { res.setHeader('Set-Cookie', 'session=s'); return res.end('Ok.'); }
      if (name === 'app/webapiVersion') return res.end('2.11.0');
      if (name === 'app/version') return res.end('v5.0');
      if (name === 'app/preferences') return send(res, { temp_path_enabled: false });
      if (name === 'torrents/info') return send(res, [{ hash: HASH, save_path: ADD.savePath, state: 'stoppedUP' }]);
      return send(res, [{ name: 'dir/movie', size: 65536, progress: 1 }, { name: 'dir/movie.!qB', size: 1, progress: 0 }]);
    });
    const info = await createClient({ type, url }).inspect(HASH);
    const actual = info.files[0].storagePaths;
    assert.ok(actual.includes('dir/movie'));
    if (type === 'transmission') assert.equal(actual.includes('dir/movie.part'), false);
    if (type === 'qbittorrent') { assert.equal(actual.includes('dir/movie.!qB'), false); assert.ok(actual.includes('dir/.unwanted/movie.!qB')); }
    assert.ok(actual.every(p => !p.startsWith('/') && !p.split('/').includes('..')));
  }
});

test('separate incomplete directories are reported read-only and refused before an add', async t => {
  for (const type of ['transmission', 'qbittorrent']) {
    let added = false;
    const url = await mock(t, (req, res, raw) => {
      if (type === 'transmission') {
        const q = JSON.parse(raw); if (q.method === 'torrent-add') added = true;
        return send(res, { result: 'success', arguments: q.method === 'session-get' ? { 'rpc-version': 17, 'incomplete-dir-enabled': true, 'incomplete-dir': '/elsewhere' } : { torrents: [] } });
      }
      const name = req.url.split('/api/v2/')[1];
      if (name === 'auth/login') { res.setHeader('Set-Cookie', 'session=s'); return res.end('Ok.'); }
      if (name === 'app/webapiVersion') return res.end('2.11.0');
      if (name === 'app/version') return res.end('v5.0');
      if (name === 'app/preferences') return send(res, { temp_path_enabled: true, temp_path: '/elsewhere' });
      if (name === 'torrents/add') added = true;
      send(res, []);
    });
    const c = createClient({ type, url });
    assert.equal((await c.test()).storage.separateIncompleteDirectory, true);
    await assert.rejects(c.addPaused(ADD), { code: 'UNSUPPORTED_STORAGE' }); assert.equal(added, false);
  }
});

test('known added ownership survives a later Transmission seeding-policy failure', async t => {
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw);
    if (q.method === 'torrent-set') return send(res, { result: 'secret policy failure' });
    return send(res, { result: 'success', arguments: q.method === 'session-get' ? { 'rpc-version': 17 } : q.method === 'torrent-get' ? { torrents: [] } : { 'torrent-added': { hashString: HASH } } });
  });
  await assert.rejects(createClient({ type: 'transmission', url }).addPaused(ADD), e => e.code === 'ADDED_SETUP_FAILED' && e.ownership.added && e.ownership.marker === 'seme-cache' && !e.message.includes('secret'));
});

test('Deluge missing hash supports empty status and InvalidTorrentError without exposing messages', async t => {
  let invalid = false;
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw);
    if (q.method === 'auth.login') { res.setHeader('Set-Cookie', 'session=s'); return send(res, { result: true }); }
    send(res, invalid ? { error: { code: 4, message: 'InvalidTorrentError: SECRET' } } : { result: {} });
  });
  const c = createClient({ type: 'deluge', url });
  assert.equal(await c.inspect(HASH), null); invalid = true; assert.equal(await c.inspect(HASH), null);
});

test('qBittorrent refuses priorities when padding exclusion changes public file indexes', async t => {
  let mutation = false;
  const url = await mock(t, (req, res) => {
    const name = req.url.split('/api/v2/')[1];
    if (name === 'auth/login') { res.setHeader('Set-Cookie', 'session=s'); return res.end('Ok.'); }
    if (name === 'app/webapiVersion') return res.end('2.11.0');
    if (name === 'app/version') return res.end('v5.0');
    if (name === 'app/preferences') return send(res, {});
    if (name === 'torrents/info') return send(res, [{ hash: HASH, save_path: ADD.savePath, state: 'stoppedUP' }]);
    if (name === 'torrents/files') return send(res, [{ index: 0, name: FILES[0].path, size: FILES[0].length, progress: 1 }]);
    mutation = true; res.end();
  });
  await assert.rejects(createClient({ type: 'qbittorrent', url }).select(HASH, [0], FILES), { code: 'FILE_LAYOUT_MISMATCH' });
  assert.equal(mutation, false);
});

test('fast verification can prove incomplete-to-complete local data without a checking snapshot', async t => {
  let verified = false;
  const url = await mock(t, (req, res, raw) => {
    const q = JSON.parse(raw);
    if (q.method === 'torrent-verify') verified = true;
    send(res, { result: 'success', arguments: q.method === 'session-get' ? { 'rpc-version': 17 } : q.method === 'torrent-get' ? { torrents: [torrent(0, verified ? FILES[0].length : FILES[0].length - 16384)] } : {} });
  });
  const c = createClient({ type: 'transmission', url });
  await c.verify(HASH);
  await c.waitVerified(HASH, [0], { timeoutMs: 20 });
  await c.resume(HASH);
});
