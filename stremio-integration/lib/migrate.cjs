'use strict';

// Explicit, journaled migration of already-owned Transmission downloads. This
// module never discovers cache data, changes selections, or adopts torrents.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { validateConfig, configPath, atomicJSON } = require('./config.cjs');
const { identity, acquireLock } = require('./runtime.cjs');
const { decodeTorrent } = require('./cache.cjs');
const { chooseDestination, destinationName, isDestinationPath } = require('./naming.cjs');
const { createClient } = require('./clients.cjs');
const HASH = /^[a-f0-9]{40}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const PHASES = new Set(['prepared', 'moving', 'moved', 'verified']);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function code(error) { return /^[A-Z][A-Z0-9_]{1,48}$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED'; }

async function read(file, limit = 32 * 1024 * 1024) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('INVALID_STATE');
    const current = await fsp.lstat(file);
    if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) fail('INVALID_STATE');
    const bytes = await handle.readFile();
    if (bytes.length > limit) fail('INVALID_STATE');
    return bytes;
  } finally { await handle.close(); }
}
async function readJSON(file) { return JSON.parse(await read(file)); }
async function directory(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder !== path.resolve(folder)) fail('INVALID_PATH');
  let current = path.parse(folder).root;
  for (const part of folder.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() && process.platform === 'darwin' && ['/tmp', '/var'].includes(current)) {
      current = await fsp.realpath(current); continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  }
  return current;
}
function marker(job, folder) { return path.join(folder, `.seme-owner-${job.ownerToken}.json`); }
async function ownedFolder(job, folder) {
  await directory(folder);
  const owner = await readJSON(marker(job, folder));
  if (owner.hash !== job.hash || owner.token !== job.ownerToken) fail('OWNERSHIP_CHANGED');
}
function validateJob(job, hash, root, torrent) {
  if (!job || job.version !== 1 || job.hash !== hash || job.phase !== 'ready' || job.added !== true || job.pending ||
      !TOKEN.test(job.ownerToken || '') || job.marker !== 'seme-cache' || !Array.isArray(job.files) || !Array.isArray(job.selected) ||
      !job.selected.length || new Set(job.selected).size !== job.selected.length ||
      job.selected.some(index => !Number.isInteger(index) || !torrent.files[index]) ||
      torrent.hash !== hash || job.files.length !== torrent.files.length ||
      torrent.files.some((file, index) => job.files[index].index !== index || job.files[index].path !== file.path || job.files[index].length !== file.length)) fail('INVALID_STATE');
  const from = path.join(root, hash);
  if (!job.relocation) {
    if (job.savePath !== from) fail('NOT_LEGACY_FOLDER');
  } else {
    const r = job.relocation;
    if (r.version !== 1 || r.from !== from || !isDestinationPath(root, r.to) || r.to === from ||
        !PHASES.has(r.phase) || typeof r.wasRunning !== 'boolean' ||
        ![r.from, r.to].includes(job.savePath)) fail('INVALID_RELOCATION');
  }
}
function layout(info, job, torrent) {
  if (!info || info.hash !== job.hash || info.marker !== 'seme-cache' || info.storageOutsideSavePath) fail('OWNERSHIP_CHANGED');
  if (info.error || !Array.isArray(info.files) || info.files.length !== torrent.files.length || torrent.files.some(file => {
    const actual = info.files.find(entry => entry.index === file.index);
    return !actual || actual.path !== file.path || actual.length !== file.length;
  })) fail('FILE_LAYOUT_CHANGED');
  if (!job.selected.every(index => {
    const file = info.files.find(entry => entry.index === index);
    return file && Number.isFinite(file.completed) && file.completed >= file.length;
  })) fail('INCOMPLETE_FILES');
  return info;
}
async function inspect(client, job, torrent, allowed) {
  const info = layout(await client.inspect(job.hash), job, torrent);
  if (!allowed.includes(info.savePath)) fail('OWNERSHIP_CHANGED');
  await ownedFolder(job, info.savePath);
  return info;
}
async function evidence(job, torrent, folder) {
  await ownedFolder(job, folder);
  // Check all existing torrent paths (including partial files) before permitting
  // the daemon to move them. Never follow a symlink into somebody else's data.
  for (const file of torrent.files) {
    for (const relative of [file.path, file.path + '.part']) {
      let current = folder, missing = false;
      const parts = relative.split('/');
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat;
        try { stat = await fsp.lstat(current); }
        catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; break; }
        if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('UNSAFE_FILE_PATH');
        if (i === parts.length - 1 && relative === file.path && job.selected.includes(file.index) && stat.size < file.length) fail('INCOMPLETE_FILES');
      }
      if (missing && relative === file.path && job.selected.includes(file.index)) fail('INCOMPLETE_FILES');
    }
  }
}
async function wait(client, job, torrent, allowed, predicate, options) {
  const deadline = Date.now() + (options.timeoutMs || 30000);
  do {
    const info = await inspect(client, job, torrent, allowed);
    if (predicate(info)) return info;
    if (Date.now() >= deadline) break;
    await delay(Math.min(options.pollIntervalMs || 100, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  fail('MIGRATION_TIMEOUT');
}
async function reserve(root, torrent, job) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const target = await chooseDestination(root, torrent.name, job.hash, { singleFile: !torrent.multiFile });
    try { await fsp.mkdir(target, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { await fsp.writeFile(marker(job, target), JSON.stringify({ hash: job.hash, token: job.ownerToken }) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { await fsp.rmdir(target).catch(() => {}); throw error; }
    return target;
  }
  fail('DESTINATION_EXISTS');
}
async function cleanup(job) {
  // Native move excludes our hidden marker. Leave arbitrary old leftovers alone.
  await ownedFolder(job, job.relocation.from);
  await fsp.unlink(marker(job, job.relocation.from));
  await fsp.rmdir(job.relocation.from).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
}

async function migrate(input, options = {}) {
  const report = { busy: false, preview: !options.apply, migrated: 0, skipped: 0, plans: [], errors: [] };
  let config = validateConfig(input);
  if (config.client.type !== 'transmission') fail('UNSUPPORTED_CLIENT');
  config = { ...config, destinationDir: await directory(config.destinationDir) };
  const stateRoot = await directory(options.stateDir || path.join(path.dirname(configPath()), 'state'));
  const release = options.apply ? await acquireLock(stateRoot) : null;
  if (options.apply && !release) return { ...report, busy: true };
  try {
    const journalDir = path.join(stateRoot, identity(config));
    try { await directory(journalDir); }
    catch (error) { if (error.code === 'ENOENT') return report; throw error; }
    const client = options.client || createClient(config.client);
    for (const filename of (await fsp.readdir(journalDir)).sort()) {
      if (!/^[a-f0-9]{40}\.json$/.test(filename)) continue;
      const hash = filename.slice(0, -5), file = path.join(journalDir, filename);
      let job, torrent, plan, authorized = false;
      const persist = () => atomicJSON(file, job);
      try {
        job = await readJSON(file);
        // Ready readable jobs and unfinished imports are outside this command.
        if (!job.relocation && (job.phase !== 'ready' || job.savePath !== path.join(config.destinationDir, hash))) { report.skipped++; continue; }
        torrent = decodeTorrent(await read(path.join(journalDir, `${hash}.torrent`), 16 * 1024 * 1024));
        validateJob(job, hash, config.destinationDir, torrent);
        const from = path.join(config.destinationDir, hash);
        const to = job.relocation ? job.relocation.to : await chooseDestination(config.destinationDir, torrent.name, hash, { singleFile: !torrent.multiFile });
        const info = await inspect(client, job, torrent, job.relocation ? [from, to] : [from]);
        await evidence(job, torrent, info.savePath);
        if (job.relocation) await ownedFolder(job, to);
        plan = { hash, name: torrent.name, from, to, status: options.apply ? 'pending' : 'preview' };
        report.plans.push(plan);
        if (!options.apply) continue;
        if (!job.relocation) {
          plan.to = await reserve(config.destinationDir, torrent, job);
          job.relocation = { version: 1, from, to: plan.to, phase: 'prepared', wasRunning: !info.paused };
          await persist();
        }
        const r = job.relocation;
        authorized = true;
        await client.pause(hash);
        let current = await wait(client, job, torrent, [r.from, r.to], live => live.paused && !live.checking, options);
        if (current.savePath === r.from) {
          if (r.phase !== 'prepared') fail('AMBIGUOUS_RELOCATION');
          await evidence(job, torrent, r.from);
          // Only the reserved marker may exist at the target before first move.
          const entries = await fsp.readdir(r.to);
          if (entries.length !== 1 || entries[0] !== path.basename(marker(job, r.to))) fail('DESTINATION_CHANGED');
          r.phase = 'moving'; await persist();
          await client.call('torrent_set_location', { ids: [hash], location: r.to, move: true });
          current = await wait(client, job, torrent, [r.from, r.to], live => live.savePath === r.to && live.paused && !live.checking, options);
        }
        if (current.savePath !== r.to) fail('AMBIGUOUS_RELOCATION');
        r.phase = 'moved'; await persist();
        await evidence(job, torrent, r.to);
        await client.verify(hash);
        await client.waitVerified(hash, job.selected, { timeoutMs: options.verifyTimeoutMs || options.timeoutMs });
        await inspect(client, job, torrent, [r.to]);
        await evidence(job, torrent, r.to);
        job.savePath = r.to;
        job.destinationName = destinationName(torrent.name, { singleFile: !torrent.multiFile });
        r.phase = 'verified'; await persist();
        // Cleanup is optional: a previous successful cleanup can precede a crash.
        try { await cleanup(job); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (r.wasRunning) await client.resume(hash);
        const finished = { ...job };
        delete finished.relocation;
        await atomicJSON(file, finished);
        job = finished;
        plan.status = 'migrated'; report.migrated++;
      } catch (error) {
        // A lost resume response can mean it started. Stop it again if ownership
        // is still provable; never send stop to an altered or foreign torrent.
        if (options.apply && authorized && job && job.relocation && torrent) {
          try {
            await inspect(client, job, torrent, [job.relocation.from, job.relocation.to]);
            await client.pause(hash);
          } catch { /* Keep the durable intent for explicit reconciliation. */ }
        }
        if (plan) plan.status = 'failed';
        report.errors.push({ hash, code: code(error) });
      }
    }
    return report;
  } finally { if (release) await release(); }
}

module.exports = { migrate };
