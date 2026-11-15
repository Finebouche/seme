'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { randomBytes } = require('crypto');
const { setTimeout: delay } = require('timers/promises');

// Only per-torrent operations live here. The runtime must establish journal
// ownership before calling pause/select/verify/resume on an existing hash.
function failure(message, code) { const e = new Error(message); if (code) e.code = code; return e; }
function hashID(hash) {
  if (!/^[a-f0-9]{40}$/i.test(hash || '')) throw failure('Invalid torrent hash');
  return hash.toLowerCase();
}
function selection(selected, files) {
  const all = files.map((f, i) => f.index === undefined ? i : f.index);
  if (!all.length || new Set(all).size !== all.length || all.some((n, i) => n !== i)) throw failure('Invalid torrent file indexes');
  const wanted = [...new Set(selected)];
  if (!wanted.length || wanted.some(n => !Number.isInteger(n) || !all.includes(n))) throw failure('Invalid selected file indexes');
  return { wanted, unwanted: all.filter(n => !wanted.includes(n)), priorities: all.map(n => wanted.includes(n) ? 1 : 0) };
}
function json(raw) { try { return JSON.parse(raw); } catch (_) { throw failure('Torrent client returned invalid JSON'); } }
function storageFiles(files, type) {
  if (files.some(f => typeof f.path !== 'string' || !f.path || f.path.includes('\\') || f.path.includes('\0') || path.posix.isAbsolute(f.path) || f.path.split('/').some(p => !p || p === '.' || p === '..'))) throw failure('Torrent client returned an unsafe relative file path', 'UNSAFE_STORAGE_PATH');
  const declared = new Set(files.map(f => f.path));
  return files.map(f => {
    const variants = type === 'transmission' ? [f.path, f.path + '.part'] : type === 'qbittorrent' ? [f.path, f.path + '.!qB', path.posix.join(path.posix.dirname(f.path), '.unwanted', path.posix.basename(f.path)), path.posix.join(path.posix.dirname(f.path), '.unwanted', path.posix.basename(f.path) + '.!qB')] : [f.path];
    return { ...f, storagePaths: [...new Set(variants)].filter(p => p === f.path || !declared.has(p)) };
  });
}
function confirmedFailure(error, ownership) {
  error.ownership = ownership;
  error.code = 'ADDED_SETUP_FAILED';
  return error;
}

class Transport {
  constructor(config, defaultPath) {
    let url;
    try { url = new URL(config.url); } catch (_) { throw failure('Torrent client URL must be HTTP or HTTPS'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw failure('Torrent client URL must be HTTP or HTTPS');
    this.username = config.username || decodeURIComponent(url.username);
    this.password = config.password || decodeURIComponent(url.password);
    url.username = ''; url.password = ''; url.hash = ''; url.search = '';
    if (url.pathname === '/') url.pathname = defaultPath;
    this.url = url;
    this.timeout = Math.min(60000, Math.max(100, Number(config.requestTimeoutMs) || 15000));
    this.cookie = '';
  }
  request(url, body, headers = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      }, response => {
        let bytes = 0; const chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) { response.destroy(); reject(failure('Torrent client response exceeds 8 MiB')); }
          else chunks.push(chunk);
        });
        response.on('error', () => reject(failure('Torrent client response interrupted')));
        response.on('end', () => {
          if (response.headers['set-cookie']) this.cookie = response.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      const timer = setTimeout(() => request.destroy(), this.timeout);
      request.on('close', () => clearTimeout(timer));
      // Never include request URLs, daemon messages, credentials or response bodies.
      request.on('error', () => reject(failure('Torrent client request failed or timed out')));
      request.end(body);
    });
  }
  check(response) {
    if (response.status !== 200) throw failure(`Torrent client HTTP ${response.status}`);
    return response.body;
  }
}

class Base {
  constructor(config) { this.pollMs = Math.max(5, Number(config.pollIntervalMs) || 500); this.checks = new Map(); }
  async absent(hash) { if (await this.inspect(hash)) throw failure('Torrent already exists; left untouched', 'DUPLICATE'); }
  async verify(hash) {
    hash = hashID(hash);
    this.checks.set(hash, { seen: false, verified: false, baseline: null });
    const baseline = await this.inspect(hash);
    if (!baseline) throw failure('Torrent disappeared before verification');
    this.checks.get(hash).baseline = baseline.paused && !baseline.checking ? baseline.files : null;
    await this.forceCheck(hash);
    const info = await this.inspect(hash);
    if (!info) throw failure('Torrent disappeared during verification');
    this.checks.get(hash).seen = info.checking;
  }
  async waitVerified(hash, selected, options = {}) {
    hash = hashID(hash);
    const check = this.checks.get(hash);
    if (!check) throw failure('A forced verification is required before seeding');
    const deadline = Date.now() + (Number(options.timeoutMs) || 120000);
    do {
      const info = await this.inspect(hash);
      if (!info) throw failure('Torrent disappeared during verification');
      if (info.error) throw failure('Torrent client reported a torrent error');
      check.seen = check.seen || info.checking;
      const completed = selected.length && selected.every(index => {
        const f = info.files.find(f => f.index === index);
        return f && Number.isFinite(f.completed) && f.completed >= f.length;
      });
      const gainedLocalPieces = completed && check.baseline && selected.some(index => {
        const before = check.baseline.find(f => f.index === index);
        const after = info.files.find(f => f.index === index);
        return before && after && before.path === after.path && before.length === after.length && Number.isFinite(before.completed) && before.completed < before.length;
      });
      // A stopped snapshot immediately after recheck can predate the queued
      // check. Observe it, or prove that previously incomplete local data became
      // complete while stopped. An unchanged complete snapshot proves nothing.
      if ((check.seen || gainedLocalPieces) && !info.checking && info.paused) {
        if (!completed) throw failure('Selected files failed verification; torrent remains paused');
        check.verified = true;
        check.selected = selected.slice();
        return info;
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw failure('Verification did not finish observably; torrent remains paused');
  }
  async resume(hash) {
    hash = hashID(hash);
    const check = this.checks.get(hash);
    if (!check || !check.verified) throw failure('Successful verification is required before seeding');
    const info = await this.inspect(hash);
    if (!info || info.checking || !info.paused || !check.selected.every(index => {
      const f = info.files.find(f => f.index === index); return f && f.completed >= f.length;
    })) throw failure('Torrent is no longer ready to seed');
    await this.start(hash);
    this.checks.delete(hash);
  }
  invalidate(hash) { this.checks.delete(hashID(hash)); }
}

// Transmission 4.1 retains legacy RPC, but use native snake_case JSON-RPC on
// RPC18+; discover that version with the backwards-compatible session-get.
const legacy = {
  rpc_version: 'rpc-version', hash_string: 'hashString', download_dir: 'downloadDir',
  bytes_completed: 'bytesCompleted', file_stats: 'fileStats', recheck_progress: 'recheckProgress',
  files_wanted: 'files-wanted', files_unwanted: 'files-unwanted', seed_ratio_mode: 'seedRatioMode', seed_idle_mode: 'seedIdleMode',
  torrent_added: 'torrent-added', torrent_duplicate: 'torrent-duplicate',
  incomplete_dir: 'incomplete-dir', incomplete_dir_enabled: 'incomplete-dir-enabled', rename_partial_files: 'rename-partial-files',
};
function translate(value, modern = false) {
  if (Array.isArray(value)) return value.map(v => translate(v, modern));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [modern ? (Object.keys(legacy).find(n => legacy[n] === k) || k) : (legacy[k] || k), translate(v, modern)]));
}
class Transmission extends Base {
  constructor(config) { super(config); this.net = new Transport(config, '/transmission/rpc'); this.token = ''; this.version = 0; }
  async call(method, args = {}, discovery = false) {
    if (!discovery && !this.version) await this.test();
    const modern = !discovery && this.version >= 18;
    let params = modern ? args : translate(args);
    if (!modern && args.fields) params.fields = args.fields.map(k => legacy[k] || k);
    if (!modern && method === 'torrent_add' && args.download_dir) { params['download-dir'] = args.download_dir; delete params.downloadDir; }
    const body = JSON.stringify(modern ? { jsonrpc: '2.0', id: 1, method, params } : { method: method.replace(/_/g, '-'), arguments: params });
    for (let i = 0; i < 3; i++) {
      const headers = { 'Content-Type': 'application/json', 'X-Transmission-Session-Id': this.token };
      if (this.net.username || this.net.password) headers.Authorization = 'Basic ' + Buffer.from(`${this.net.username}:${this.net.password}`).toString('base64');
      const r = await this.net.request(this.net.url, body, headers);
      if (r.status === 409 && r.headers['x-transmission-session-id']) { this.token = r.headers['x-transmission-session-id']; continue; }
      const data = json(this.net.check(r));
      if (data.error || (!modern && data.result !== 'success')) throw failure('Transmission RPC rejected the operation');
      return modern ? data.result : translate(data.arguments, true);
    }
    throw failure('Transmission session handshake failed');
  }
  async test() { const info = await this.call('session_get', {}, true); if (!(info.rpc_version >= 17)) throw failure('Transmission 4.0 or newer is required for atomic ownership labels'); this.version = info.rpc_version; this.session = info; return { type: 'transmission', version: info.version, storage: { separateIncompleteDirectory: !!info.incomplete_dir_enabled } }; }
  async inspect(hash) {
    hash = hashID(hash);
    const data = await this.call('torrent_get', { ids: [hash], fields: ['hash_string', 'download_dir', 'labels', 'status', 'error', 'files', 'file_stats'] });
    const t = data.torrents.find(t => t.hash_string.toLowerCase() === hash);
    if (!t) return null;
    return { hash, savePath: t.download_dir, marker: (t.labels || []).includes('seme-cache') ? 'seme-cache' : null, paused: t.status === 0, checking: t.status === 1 || t.status === 2, error: !!t.error,
      incompleteDir: this.session.incomplete_dir_enabled ? this.session.incomplete_dir : null,
      storageOutsideSavePath: !!(this.session.incomplete_dir_enabled && path.resolve(this.session.incomplete_dir || '/') !== path.resolve(t.download_dir)),
      files: storageFiles(t.files.map((f, index) => ({ index, path: f.name, length: f.length, completed: f.bytes_completed })), 'transmission'), raw: t };
  }
  async addPaused({ hash, torrent, savePath, selected, files }) {
    hash = hashID(hash); const s = selection(selected, files); await this.absent(hash);
    if (this.session.incomplete_dir_enabled && path.resolve(this.session.incomplete_dir || '/') !== path.resolve(savePath)) throw failure('Disable the separate incomplete directory in Transmission before cache transfers', 'UNSUPPORTED_STORAGE');
    const args = { metainfo: torrent.toString('base64'), download_dir: savePath, labels: ['seme-cache'], paused: true, files_wanted: s.wanted };
    if (s.unwanted.length) args.files_unwanted = s.unwanted;
    const added = await this.call('torrent_add', args);
    if (added.torrent_duplicate) throw failure('Torrent add raced with an existing torrent; left untouched', 'DUPLICATE');
    if (!added.torrent_added || added.torrent_added.hash_string.toLowerCase() !== hash) throw failure('Transmission did not confirm the added torrent');
    const ownership = { added: true, hash, savePath, marker: 'seme-cache' };
    try { await this.call('torrent_set', { ids: [hash], seed_ratio_mode: 2, seed_idle_mode: 2 }); }
    catch (error) { throw confirmedFailure(error, ownership); }
    return ownership;
  }
  async select(hash, selected, files) { this.invalidate(hash); const s = selection(selected, files); const args = { ids: [hash], files_wanted: s.wanted }; if (s.unwanted.length) args.files_unwanted = s.unwanted; await this.call('torrent_set', args); }
  async pause(hash) { hash = hashID(hash); await this.call('torrent_stop', { ids: [hash] }); }
  async forceCheck(hash) { await this.call('torrent_verify', { ids: [hash] }); }
  async start(hash) { await this.call('torrent_start', { ids: [hash] }); }
}

class Qbittorrent extends Base {
  constructor(config) { super(config); this.net = new Transport(config, '/'); this.apiVersion = ''; }
  endpoint(name) { return new URL(this.net.url.pathname.replace(/\/$/, '').replace(/\/api\/v2$/, '') + '/api/v2/' + name, this.net.url); }
  async login() {
    const body = new URLSearchParams({ username: this.net.username, password: this.net.password }).toString();
    const r = await this.net.request(this.endpoint('auth/login'), body, { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.net.url.origin + '/' });
    if (this.net.check(r).trim() !== 'Ok.') throw failure('qBittorrent authentication failed');
  }
  async call(name, params = {}, multipart) {
    const body = multipart ? multipart.body : new URLSearchParams(params).toString();
    const headers = { 'Content-Type': multipart ? multipart.type : 'application/x-www-form-urlencoded', Referer: this.net.url.origin + '/' };
    if (!this.net.cookie) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.net.request(this.endpoint(name), body, headers);
      if (r.status === 403 && attempt === 0) { await this.login(); continue; }
      return this.net.check(r);
    }
    throw failure('qBittorrent authentication failed');
  }
  async test() { this.apiVersion = (await this.call('app/webapiVersion')).trim(); this.preferences = json(await this.call('app/preferences')); return { type: 'qbittorrent', version: (await this.call('app/version')).trim(), storage: { separateIncompleteDirectory: !!this.preferences.temp_path_enabled } }; }
  async inspect(hash) {
    hash = hashID(hash); if (!this.apiVersion) await this.test(); const t = json(await this.call('torrents/info', { hashes: hash })).find(t => t.hash.toLowerCase() === hash);
    if (!t) return null;
    const files = json(await this.call('torrents/files', { hash }));
    return { hash, savePath: t.save_path, marker: String(t.tags || '').split(',').map(s => s.trim()).find(s => /^seme-[a-f0-9]{32}$/.test(s)) || null, paused: /^(paused|stopped)/i.test(t.state), checking: /^(checking|queuedForChecking)/i.test(t.state), error: /error|missingFiles/i.test(t.state),
      incompleteDir: t.download_path || (this.preferences.temp_path_enabled ? this.preferences.temp_path : null),
      storageOutsideSavePath: !!this.preferences.temp_path_enabled || !!(t.content_path && path.relative(t.save_path, t.content_path).split(path.sep).includes('..')),
      files: storageFiles(files.map((f, index) => ({ index: f.index === undefined ? index : f.index, path: f.name, length: f.size, completed: f.progress >= 1 ? f.size : Math.floor(f.size * f.progress) })), 'qbittorrent'), raw: t };
  }
  async addPaused({ hash, torrent, savePath, selected, files }) {
    hash = hashID(hash); selection(selected, files);
    if (!this.apiVersion) await this.test();
    const [major, minor] = this.apiVersion.split('.').map(Number);
    if (!(major > 2 || (major === 2 && minor >= 7))) throw failure('qBittorrent Web API 2.7 or newer is required');
    if (this.preferences.temp_path_enabled) throw failure('Disable the separate incomplete directory in qBittorrent before cache transfers', 'UNSUPPORTED_STORAGE');
    await this.absent(hash);
    const token = 'seme-' + randomBytes(16).toString('hex');
    const boundary = 'seme' + randomBytes(12).toString('hex');
    const values = { savepath: savePath, useDownloadPath: 'false', paused: 'true', stopped: 'true', autoTMM: 'false', contentLayout: 'Original', tags: token, skip_checking: 'false', ratioLimit: '-1', seedingTimeLimit: '-1', inactiveSeedingTimeLimit: '-1' };
    const chunks = [];
    for (const [name, value] of Object.entries(values)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="seme.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`), torrent, Buffer.from(`\r\n--${boundary}--\r\n`));
    if ((await this.call('torrents/add', {}, { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` })).trim() !== 'Ok.') throw failure('qBittorrent did not accept the torrent');
    let info;
    for (let i = 0; i < 20; i++) { info = await this.inspect(hash); if (info) break; await delay(this.pollMs); }
    // Duplicate add has no response flag. Its existing torrent must not gain
    // this random, atomically supplied tag. Never re-tag or adopt a duplicate.
    if (!info || !String(info.raw.tags || '').split(',').map(s => s.trim()).includes(token) || path.resolve(info.savePath) !== path.resolve(savePath)) throw failure('qBittorrent add ownership was not confirmed', 'DUPLICATE');
    const ownership = { added: true, hash, savePath, marker: token };
    try {
      if (!info.paused && !info.checking) throw failure('qBittorrent did not add the torrent stopped');
      await this.select(hash, selected, files);
      await this.call('torrents/setShareLimits', { hashes: hash, ratioLimit: -1, seedingTimeLimit: -1, inactiveSeedingTimeLimit: -1 });
    } catch (error) { throw confirmedFailure(error, ownership); }
    return ownership;
  }
  async select(hash, selected, files) {
    this.invalidate(hash); const s = selection(selected, files);
    // qBittorrent hides padding files from its public indexes. Do not apply
    // metainfo indexes to a different public file ordering (including renamed
    // files or a non-Original content layout).
    const info = await this.inspect(hash);
    if (!info || info.files.length !== files.length || files.some((f, index) => {
      const actual = info.files.find(f => f.index === index);
      return !actual || actual.path !== f.path || actual.length !== f.length;
    })) throw failure('qBittorrent file indexes do not match the exported torrent layout', 'FILE_LAYOUT_MISMATCH');
    if (s.unwanted.length) await this.call('torrents/filePrio', { hash, id: s.unwanted.join('|'), priority: 0 });
    await this.call('torrents/filePrio', { hash, id: s.wanted.join('|'), priority: 1 });
  }
  async action(hash, modern, old) {
    hash = hashID(hash);
    if (!this.apiVersion) await this.test();
    const [major, minor] = this.apiVersion.split('.').map(Number);
    return this.call(`torrents/${major > 2 || (major === 2 && minor >= 11) ? modern : old}`, { hashes: hash });
  }
  async pause(hash) { await this.action(hash, 'stop', 'pause'); }
  async start(hash) { await this.action(hash, 'start', 'resume'); }
  async forceCheck(hash) { await this.call('torrents/recheck', { hashes: hash }); }
}

class Deluge extends Base {
  constructor(config) { super(config); this.net = new Transport(config, '/json'); this.id = 0; }
  async raw(method, params) {
    const data = json(this.net.check(await this.net.request(this.net.url, JSON.stringify({ id: ++this.id, method, params }), { 'Content-Type': 'application/json' })));
    if (data.error) {
      const code = data.error.code === 1 ? 'AUTH' : /\bInvalidTorrentError\b/.test(String(data.error.message || '')) ? 'NOT_FOUND' : 'RPC';
      throw failure('Deluge RPC rejected the operation', code);
    }
    return data.result;
  }
  async login() { if (!(await this.raw('auth.login', [this.net.password]))) throw failure('Deluge authentication failed'); }
  async call(method, params = []) {
    if (!this.net.cookie) await this.login();
    try { return await this.raw(method, params); } catch (e) { if (e.code !== 'AUTH') throw e; await this.login(); return this.raw(method, params); }
  }
  async test() {
    if (!(await this.call('web.connected'))) throw failure('Deluge Web is not connected to its daemon');
    return { type: 'deluge', version: await this.call('daemon.info') };
  }
  async inspect(hash) {
    hash = hashID(hash);
    let t;
    try { t = await this.call('core.get_torrent_status', [hash, ['name', 'save_path', 'state', 'paused', 'files', 'file_progress', 'file_priorities']]); }
    catch (error) { if (error.code === 'NOT_FOUND') return null; throw error; }
    if (!t || !Object.keys(t).length) return null;
    return { hash, savePath: t.save_path, paused: t.paused === true || t.state === 'Paused', checking: t.state === 'Checking', error: t.state === 'Error',
      storageOutsideSavePath: false,
      files: storageFiles((t.files || []).map((f, index) => ({ index: f.index === undefined ? index : f.index, path: f.path, length: f.size, completed: t.file_progress[index] >= 1 ? f.size : Math.floor(f.size * t.file_progress[index]) })), 'deluge'), raw: t };
  }
  async addPaused({ hash, torrent, savePath, selected, files }) {
    hash = hashID(hash); const s = selection(selected, files); await this.absent(hash);
    const added = await this.call('core.add_torrent_file', ['seme.torrent', torrent.toString('base64'), { download_location: savePath, add_paused: true, auto_managed: false, file_priorities: s.priorities, stop_at_ratio: false, remove_at_ratio: false, move_completed: false }]);
    if (typeof added !== 'string' || added.toLowerCase() !== hash) throw failure('Deluge did not confirm a newly added torrent', 'DUPLICATE');
    return { added: true, hash, savePath };
  }
  async select(hash, selected, files) { this.invalidate(hash); const s = selection(selected, files); await this.call('core.set_torrent_options', [[hash], { file_priorities: s.priorities }]); }
  async pause(hash) { await this.call('core.pause_torrent', [[hashID(hash)]]); }
  async start(hash) { await this.call('core.resume_torrent', [[hash]]); }
  async forceCheck(hash) { await this.call('core.force_recheck', [[hash]]); }
}

function createClient(config) {
  const C = { transmission: Transmission, qbittorrent: Qbittorrent, deluge: Deluge }[config.type];
  if (!C) throw failure('Unsupported torrent client');
  return new C(config);
}
module.exports = { createClient };
