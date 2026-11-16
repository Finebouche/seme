'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const { configPath, loadConfig, validateConfig, atomicJSON, atomicFile, privateDirectory, overlaps } = require('./config.cjs');
const cache = require('./cache.cjs');
const { createClient } = require('./clients.cjs');
const { chooseDestination, destinationName, isDestinationPath, isDestinationName } = require('./naming.cjs');
const HASH = /^[0-9a-f]{40}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function identity(config) {
  return crypto.createHash('sha256').update(JSON.stringify([config.client.type, config.client.url, config.destinationDir])).digest('hex').slice(0, 24);
}
function samePath(a, b) { return typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b); }

async function readJSON(file) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('INVALID_STATE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function acquireLock(directory) {
  await privateDirectory(directory);
  const lock = path.join(directory, 'transfer.lock');
  const token = crypto.randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return async () => {
        try { if ((await readJSON(lock)).token === token) await fsp.unlink(lock); } catch { /* Never remove another process's lock. */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readJSON(lock);
      if (!Number.isInteger(previous.pid) || previous.pid <= 0) fail('INVALID_LOCK');
      try { process.kill(previous.pid, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') return null; }
      if ((await readJSON(lock)).token !== previous.token) return null;
      await fsp.unlink(lock);
    }
  }
  return null;
}

// Reject cache/destination aliases and symlinked final directories. The two
// stores must be independent so eviction never deletes preserved data.
async function resolvedConfig(config) {
  const result = validateConfig(config);
  await privateDirectory(result.destinationDir);
  result.destinationDir = await fsp.realpath(result.destinationDir);
  let cacheReal = result.cacheDir;
  try {
    const stat = await fsp.lstat(result.cacheDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_CACHE_FOLDER');
    cacheReal = await fsp.realpath(result.cacheDir);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (overlaps(cacheReal, result.destinationDir) || overlaps(result.destinationDir, cacheReal)) fail('OVERLAPPING_FOLDERS');
  return result;
}

async function childFile(root, relative, create = true) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) fail('UNSAFE_FILE_PATH');
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) fail('UNSAFE_FILE_PATH');
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNSAFE_FILE_PATH');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (create) await fsp.mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fsp.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_FILE_PATH');
  }
  return path.join(root, ...parts);
}

async function assertOwned(client, job) {
  const info = await client.inspect(job.hash);
  if (!job.added || !info || !samePath(info.savePath, job.savePath) || (job.marker && job.marker !== info.marker)) fail('OWNERSHIP_CHANGED');
  if (info.storageOutsideSavePath) fail('UNSUPPORTED_STORAGE');
  const stat = await fsp.lstat(job.savePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DESTINATION');
  if (job.ownerToken) await assertSnapshotOwner(job);
  return info;
}

async function assertSnapshotOwner(job) {
  if (!/^[a-f0-9]{32}$/.test(job.ownerToken || '')) fail('INVALID_STATE');
  const stat = await fsp.lstat(job.savePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DESTINATION');
  const marker = await readJSON(path.join(job.savePath, `.seme-owner-${job.ownerToken}.json`));
  if (marker.hash !== job.hash || marker.token !== job.ownerToken) fail('OWNERSHIP_CHANGED');
}

async function pauseOwned(client, job) {
  await assertOwned(client, job);
  await client.pause(job.hash);
  const deadline = Date.now() + 30000;
  do {
    const info = await assertOwned(client, job);
    if (info.paused && !info.checking) return;
    await delay(250);
  } while (Date.now() < deadline);
  fail('PAUSE_TIMEOUT');
}

// Staging is an independent snapshot, never a hardlink into Stremio's cache.
// For an existing season, preserve all previous episodes and merge only the
// validated ranges that cover the newly completed episode's torrent pieces.
async function mergeSnapshot(job, storageInfo) {
  for (const file of job.pending.files) {
    if (!file.ranges || !file.ranges.length) continue;
    const source = await childFile(job.pending.stagePath, file.path);
    const variants = new Set([file.path]);
    const actual = storageInfo && storageInfo.files.find(entry => entry.index === file.index);
    for (const relative of actual && actual.storagePaths || []) {
      if (relative === file.path || job.files.some(other => other.index !== file.index && other.path === relative)) continue;
      // Do not create every possible client-specific alternate. Update only
      // existing ones, plus the normal path used for new imports.
      try { await fsp.lstat(await childFile(job.savePath, relative, false)); variants.add(relative); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const relative of variants) {
      const target = await childFile(job.savePath, relative);
      const input = await fsp.open(source, fs.constants.O_RDONLY | NOFOLLOW);
      let output;
      try {
        const srcStat = await input.stat();
        if (!srcStat.isFile()) fail('UNSAFE_STAGING_FILE');
        try {
          output = await fsp.open(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          output = await fsp.open(target, fs.constants.O_RDWR | NOFOLLOW);
        }
        const outStat = await output.stat();
        if (!outStat.isFile() || outStat.nlink !== 1) fail('UNSAFE_DESTINATION');
        const buffer = Buffer.alloc(1024 * 1024);
        for (const range of file.ranges) {
          if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end > file.length || range.start >= range.end) fail('INVALID_STATE');
          let position = range.start;
          while (position < range.end) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, range.end - position), position);
            if (!bytesRead) fail('INCOMPLETE_SNAPSHOT');
            let written = 0;
            while (written < bytesRead) {
              const result = await output.write(buffer, written, bytesRead - written, position + written);
              if (!result.bytesWritten) fail('WRITE_FAILED');
              written += result.bytesWritten;
            }
            position += bytesRead;
          }
        }
        await output.sync();
      } finally { await input.close(); if (output) await output.close(); }
    }
  }
}

function checkJob(job, config) {
  if (!job || !HASH.test(job.hash) || job.version !== 1 || !isDestinationPath(config.destinationDir, job.savePath)) fail('INVALID_STATE');
  if (job.destinationName !== undefined && !isDestinationName(job.destinationName)) fail('INVALID_STATE');
  if (job.destinationReserved !== undefined && typeof job.destinationReserved !== 'boolean') fail('INVALID_STATE');
  if (!Array.isArray(job.selected) || !Array.isArray(job.files) || typeof job.added !== 'boolean') fail('INVALID_STATE');
  if (job.pending) {
    const staging = path.join(config.destinationDir, '.seme-staging');
    if (!samePath(path.dirname(path.dirname(job.pending.stagePath)), staging) || path.basename(job.pending.stagePath) !== job.hash) fail('INVALID_STATE');
    if (!Array.isArray(job.pending.files) || !Array.isArray(job.pending.selected)) fail('INVALID_STATE');
  }
}

async function moveSnapshot(job, config, persist) {
  // mkdir reserves a new name without rename's ability to replace an existing
  // empty directory. A simultaneous import must choose its next hash suffix.
  for (;;) {
    let exists = true;
    try { await fsp.lstat(job.savePath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (exists) {
      try { await assertSnapshotOwner(job); }
      catch (error) {
        if (!job.destinationName || job.destinationReserved) throw error;
        if (!['ENOENT', 'ELOOP', 'INVALID_STATE', 'OWNERSHIP_CHANGED', 'UNSAFE_DESTINATION'].includes(error.code)) throw error;
        job.savePath = await chooseDestination(config.destinationDir, job.destinationName, job.hash);
        await persist(job);
        continue;
      }
      break;
    }
    if (job.destinationReserved) fail('OWNERSHIP_CHANGED');
    const stageStat = await fsp.lstat(job.pending.stagePath);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail('UNSAFE_STAGING_FILE');
    try { await fsp.mkdir(job.savePath, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    await atomicJSON(path.join(job.savePath, `.seme-owner-${job.ownerToken}.json`), { hash: job.hash, token: job.ownerToken });
    break;
  }
  const rootStat = await fsp.lstat(job.savePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNSAFE_DESTINATION');
  await assertSnapshotOwner(job);
  if (!job.destinationReserved) {
    job.destinationReserved = true;
    await persist(job);
  }
  let entries;
  try { entries = await fsp.readdir(job.pending.stagePath); }
  catch (error) {
    // Older journals moved the entire snapshot in one rename.
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const stageStat = await fsp.lstat(job.pending.stagePath);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail('UNSAFE_STAGING_FILE');
  for (const entry of entries) {
    if (entry === `.seme-owner-${job.ownerToken}.json`) continue;
    const target = path.join(job.savePath, entry);
    try { await fsp.lstat(target); fail('DESTINATION_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fsp.rename(path.join(job.pending.stagePath, entry), target);
  }
}

function publicCode(error) {
  // RPC bodies, tracker URLs and credentials never reach Stremio's log.
  const code = error && error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,48}$/.test(code) ? code : 'TRANSFER_FAILED';
}

async function scan(config, options = {}) {
  const stateRoot = options.stateDir || path.join(path.dirname(configPath()), 'state');
  const release = await acquireLock(stateRoot);
  if (!release) return { busy: true, imported: 0, skipped: 0, errors: [] };
  const report = { lastScan: new Date().toISOString(), imported: 0, skipped: 0, errors: [] };
  try {
    config = await resolvedConfig(config);
    const client = options.client || createClient(config.client);
    const cacheAPI = options.cache || cache;
    const journalDir = path.join(stateRoot, identity(config));
    await privateDirectory(journalDir);
    const persist = job => atomicJSON(path.join(journalDir, `${job.hash}.json`), job);
    const candidates = await cacheAPI.discover(config.cacheDir, { onError: (error, hash) => {
      // Stremio routinely leaves metadata-only folders and evicts data while we
      // scan. Missing cache files are expected, not a failed transfer.
      if (error.code !== 'ENOENT') report.errors.push({ hash, code: 'CACHE_UNAVAILABLE' });
    } });
    const byHash = new Map(candidates.map(candidate => [candidate.hash, candidate]));
    const jobs = new Map();
    for (const file of await fsp.readdir(journalDir)) {
      if (!/^[0-9a-f]{40}\.json$/.test(file)) continue;
      try {
        const job = await readJSON(path.join(journalDir, file));
        checkJob(job, config);
        jobs.set(job.hash, job);
        if (job.phase !== 'ready' || job.relocation) byHash.set(job.hash, byHash.get(job.hash) || null);
      } catch (error) {
        byHash.delete(file.slice(0, -5));
        report.errors.push({ hash: file.slice(0, -5), code: 'INVALID_STATE' });
      }
    }
    for (const [hash, candidate] of byHash) {
      if (!HASH.test(hash)) continue;
      try {
        let job = jobs.get(hash);
        if (job && job.relocation) fail('MIGRATION_REQUIRED');
        if (job && job.phase === 'setup-failed') fail('ADDED_SETUP_FAILED');
        if (job && !job.added && job.phase === 'adding') fail('AMBIGUOUS_ADD');
        if (job && job.phase === 'ready' && candidate && candidate.selected.every(index => job.selected.includes(index))) continue;
        const live = await client.inspect(hash);
        if (live && (!job || !job.added)) { report.skipped++; continue; }
        if (job && job.added) await assertOwned(client, job);
        if (!job || job.phase === 'ready') {
          if (!candidate) continue;
          const selected = candidate.selected.filter(index => !job || !job.selected.includes(index));
          if (!selected.length) continue;
          if (!job && typeof client.test === 'function') {
            const connection = await client.test();
            if (connection.storage && connection.storage.separateIncompleteDirectory) fail('UNSUPPORTED_STORAGE');
          }
          const stagingRoot = path.join(config.destinationDir, '.seme-staging');
          await privateDirectory(stagingRoot);
          const stageParent = await fsp.mkdtemp(path.join(stagingRoot, 'transfer-'));
          let exported;
          try {
            const copies = { qbittorrent: 4, transmission: 2, deluge: 1 }[config.client.type];
            const mergeBudget = job ? copies * (candidate.files.filter(file => selected.includes(file.index)).reduce((sum, file) => sum + file.length, 0)
              + 2 * candidate.pieceLength * selected.length) : 0;
            exported = await cacheAPI.exportCandidate(candidate, stageParent, { selected, minFreeBytes: config.minFreeBytes + mergeBudget });
          } catch (error) {
            await fsp.rm(stageParent, { recursive: true, force: true });
            throw error;
          }
          if (!job) {
            const name = destinationName(candidate.name, { singleFile: candidate.multiFile === false });
            job = { version: 1, hash, savePath: await chooseDestination(config.destinationDir, name, hash), destinationName: name,
              selected: [], files: exported.files, added: false, ownerToken: crypto.randomBytes(16).toString('hex') };
          }
          job.pending = { stagePath: exported.savePath, files: exported.files, selected, shouldResume: !job.added || !live.paused };
          job.phase = 'prepared';
          // Metainfo is kept outside the download tree, and never logged.
          const torrentFile = path.join(journalDir, `${hash}.torrent`);
          await atomicFile(torrentFile, exported.torrent);
          if (!job.added) await atomicJSON(path.join(exported.savePath, `.seme-owner-${job.ownerToken}.json`), { hash, token: job.ownerToken });
          await persist(job);
        }
        if (!job.added) {
          if (job.phase === 'adding') fail('AMBIGUOUS_ADD');
          if (job.phase === 'prepared') {
            // Record intent before reserving and moving. Its ownership marker
            // distinguishes our moved snapshot from any preexisting directory.
            job.phase = 'moving';
            await persist(job);
          }
          if (job.phase === 'moving') {
            await moveSnapshot(job, config, persist);
          }
          job.phase = 'adding';
          await persist(job);
          let result;
          try {
            result = await client.addPaused({ hash, torrent: await fsp.readFile(path.join(journalDir, `${hash}.torrent`)), savePath: job.savePath, selected: job.pending.selected, files: job.files });
          } catch (error) {
            if (error.ownership && error.ownership.added && error.ownership.hash === hash && samePath(error.ownership.savePath, job.savePath)) {
              job.added = true;
              job.marker = error.ownership.marker;
              job.phase = 'setup-failed';
              await persist(job);
            }
            throw error;
          }
          if (!result || !result.added) fail('AMBIGUOUS_ADD');
          job.added = true;
          job.marker = result.marker;
          job.phase = 'verifying';
          await persist(job);
        } else if (job.phase === 'prepared') {
          await pauseOwned(client, job);
          await client.select(hash, [...new Set([...job.selected, ...job.pending.selected])], job.files);
          await mergeSnapshot(job, await assertOwned(client, job));
          job.phase = 'verifying';
          await persist(job);
        }
        const allSelected = [...new Set([...job.selected, ...job.pending.selected])].sort((a, b) => a - b);
        await pauseOwned(client, job);
        await assertOwned(client, job);
        await client.select(hash, allSelected, job.files);
        await assertOwned(client, job);
        await client.verify(hash);
        await client.waitVerified(hash, allSelected, { timeoutMs: options.verifyTimeoutMs || 120000 });
        await assertOwned(client, job);
        if (job.pending.shouldResume) await client.resume(hash);
        const stageParent = path.dirname(job.pending.stagePath);
        job.selected = allSelected;
        job.phase = 'ready';
        delete job.pending;
        await persist(job);
        await fsp.rm(stageParent, { recursive: true, force: true });
        report.imported++;
      } catch (error) { report.errors.push({ hash, code: publicCode(error) }); }
    }
    return report;
  } finally { await release(); }
}

function start(options = {}) {
  const file = options.configFile || configPath();
  let stopped = false, timer;
  let lastMessage = '';
  const log = options.log || (message => console.error(`[Sème] ${message}`));
  async function tick() {
    let interval = 30;
    try {
      const config = await loadConfig(file);
      interval = config.intervalSeconds;
      const report = config.enabled ? await scan(config, { stateDir: path.join(path.dirname(file), 'state') })
        : { lastScan: new Date().toISOString(), enabled: false, imported: 0, skipped: 0, errors: [] };
      await atomicJSON(path.join(path.dirname(file), 'status.json'), report);
      const message = report.errors.length ? `Transfer needs attention (${report.errors[0].code}). Open Sème Setup for diagnostics.`
        : report.imported ? `Preserved ${report.imported} torrent(s); the torrent client now handles sharing.` : '';
      if (message && message !== lastMessage) log(message);
      lastMessage = message;
    } catch (error) {
      const message = error.code === 'ENOENT' ? 'Configure Sème Setup to enable cache transfers.' : `Integration idle (${publicCode(error)}); Stremio continues normally.`;
      if (message !== lastMessage) log(message);
      lastMessage = message;
      if (error.code !== 'ENOENT') await atomicJSON(path.join(path.dirname(file), 'status.json'), {
        lastScan: new Date().toISOString(), imported: 0, skipped: 0, errors: [{ code: publicCode(error) }],
      }).catch(() => {});
    } finally {
      if (!stopped) { timer = setTimeout(tick, interval * 1000); timer.unref(); }
    }
  }
  timer = setTimeout(tick, options.initialDelayMs === undefined ? 3000 : options.initialDelayMs);
  timer.unref();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

module.exports = { start, scan, identity, mergeSnapshot, acquireLock };
