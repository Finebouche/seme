'use strict';

// Stremio's disk store: <info hash>/{cache,bitfield,0,1,...}. Never write here.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const LIMITS = Object.freeze({ torrentBytes: 16 * 1024 * 1024, nodes: 200000,
  depth: 32, files: 20000, pieces: 500000, pieceLength: 64 * 1024 * 1024,
  totalLength: 16 * 1024 ** 4 });
const VIDEO = /\.(?:mkv|mp4|avi|mov|m4v|webm|mpg|mpeg|ts|m2ts|wmv|ogv)$/i;
const HASH = /^[a-f0-9]{40}$/i;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function fail(message) { throw new Error(message); }
function integer(value, max, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${label}`);
  return value;
}

// Preserve the original info dictionary bytes: re-encoding changes the identity.
function decodeTorrent(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > LIMITS.torrentBytes) fail('Torrent too large');
  let pos = 0, nodes = 0, infoStart, infoEnd;
  function bytes() {
    const start = pos;
    while (pos < buffer.length && buffer[pos] >= 48 && buffer[pos] <= 57) pos++;
    if (pos === start || pos - start > 10 || buffer[pos++] !== 58) fail('Invalid bencode string');
    const digits = buffer.toString('ascii', start, pos - 1);
    if (digits.length > 1 && digits[0] === '0') fail('Noncanonical string length');
    const length = Number(digits);
    if (!Number.isSafeInteger(length) || length > buffer.length - pos) fail('Truncated bencode string');
    const result = buffer.subarray(pos, pos + length); pos += length;
    return result;
  }
  function value(depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth || pos >= buffer.length) fail('Bencode bounds exceeded');
    const token = buffer[pos];
    if (token >= 48 && token <= 57) return bytes();
    if (token === 105) {
      const start = ++pos, end = buffer.indexOf(101, start);
      if (end < 0 || end - start > 17) fail('Invalid bencode integer');
      const text = buffer.toString('ascii', start, end);
      if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(text)) fail('Invalid bencode integer');
      pos = end + 1;
      const number = Number(text);
      if (!Number.isSafeInteger(number)) fail('Unsafe bencode integer');
      return number;
    }
    if (token !== 108 && token !== 100) fail('Invalid bencode token');
    pos++;
    const dictionary = token === 100;
    const result = dictionary ? Object.create(null) : [];
    while (pos < buffer.length && buffer[pos] !== 101) {
      if (dictionary) {
        if (++nodes > LIMITS.nodes) fail('Bencode bounds exceeded');
        const keyBytes = bytes();
        const key = keyBytes.toString('hex');
        if (Object.hasOwn(result, key)) fail('Duplicate bencode key');
        const start = pos;
        result[key] = value(depth + 1);
        if (depth === 0 && keyBytes.equals(Buffer.from('info'))) { infoStart = start; infoEnd = pos; }
      } else result.push(value(depth + 1));
    }
    if (buffer[pos++] !== 101) fail('Unterminated bencode container');
    return result;
  }
  const top = value(0);
  if (pos !== buffer.length || !top || Array.isArray(top) || infoStart === undefined) fail('Invalid torrent dictionary');
  const get = (obj, key) => obj && obj[Buffer.from(key).toString('hex')];
  const info = get(top, 'info');
  if (!info || Buffer.isBuffer(info) || Array.isArray(info) || typeof info !== 'object') fail('Invalid info dictionary');
  const pieces = get(info, 'pieces');
  if (!Buffer.isBuffer(pieces) || !pieces.length || pieces.length % 20 || pieces.length / 20 > LIMITS.pieces) fail('Missing or invalid v1 piece hashes (v2-only is unsupported)');
  const pieceLength = integer(get(info, 'piece length'), LIMITS.pieceLength, 'piece length', 1);
  function component(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 255) fail('Invalid torrent path');
    let text;
    try { text = utf8.decode(raw); } catch { fail('Invalid UTF-8 torrent path'); }
    if (text === '.' || text === '..' || /[\x00-\x1f\x7f/\\:]/.test(text) || /[. ]$/.test(text) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) fail('Unsafe torrent path');
    return text;
  }
  const name = component(get(info, 'name.utf-8') || get(info, 'name'));
  const entries = get(info, 'files');
  const multiFile = entries !== undefined;
  if (multiFile && (!Array.isArray(entries) || !entries.length || entries.length > LIMITS.files || get(info, 'length') !== undefined)) fail('Invalid files list');
  let offset = 0;
  const files = (multiFile ? entries : [info]).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Buffer.isBuffer(entry) || Array.isArray(entry)) fail('Invalid file entry');
    const length = integer(get(entry, 'length'), LIMITS.totalLength, 'file length');
    const attr = get(entry, 'attr');
    if (get(entry, 'symlink path') !== undefined || (Buffer.isBuffer(attr) && attr.includes(108))) fail('Torrent symlinks are unsupported');
    let segments = [];
    if (multiFile) {
      const raw = get(entry, 'path.utf-8') || get(entry, 'path');
      if (!Array.isArray(raw) || !raw.length || raw.length > 32) fail('Invalid file path');
      segments = raw.map(component);
    }
    const relative = [name, ...segments].join('/');
    if (Buffer.byteLength(relative) > 4096) fail('Torrent path too long');
    const result = { index, path: relative, length, offset };
    offset = integer(offset + length, LIMITS.totalLength, 'torrent length');
    return result;
  });
  const names = new Set();
  // Conservative case/Unicode folding also prevents collisions on default APFS.
  for (const file of files) {
    const name = file.path.normalize('NFC').toLowerCase();
    if (names.has(name)) fail('Colliding torrent paths');
    names.add(name);
  }
  for (const name of names) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (names.has(parent)) fail('File/directory path collision');
      parent = path.posix.dirname(parent);
    }
  }
  if (!offset || Math.ceil(offset / pieceLength) !== pieces.length / 20) fail('Piece count does not match torrent length');
  return { hash: crypto.createHash('sha1').update(buffer.subarray(infoStart, infoEnd)).digest('hex'),
    torrent: buffer, files, name, multiFile, totalLength: offset, pieceLength, pieces };
}

async function rootDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('Expected absolute directory path');
  let current = path.parse(directory).root;
  for (const part of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await fsp.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(current);
    }
    // macOS exposes its system temporary directories through these two aliases.
    const systemAlias = process.platform === 'darwin' && ['/tmp', '/var'].includes(current);
    if (stat.isSymbolicLink() && systemAlias) { current = await fsp.realpath(current); continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Unsafe directory: ${current}`);
  }
  return current;
}

async function openRegular(filename, maxBytes) {
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail(`Invalid cache file: ${filename}`);
    const current = await fsp.lstat(filename);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) fail('Cache file changed');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

async function readSmall(filename, maxBytes) {
  const { handle, stat } = await openRegular(filename, maxBytes);
  try {
    const data = Buffer.alloc(stat.size);
    await readExact(handle, data, 0, data.length, 0);
    const extra = await handle.read(Buffer.alloc(1), 0, 1, data.length);
    if (extra.bytesRead) fail('Cache file grew beyond limit');
    return data;
  }
  finally { await handle.close(); }
}

function pieceRange(file, torrent) {
  return { start: Math.floor(file.offset / torrent.pieceLength) * torrent.pieceLength,
    end: Math.min(torrent.totalLength, Math.ceil((file.offset + file.length) / torrent.pieceLength) * torrent.pieceLength) };
}

function intersecting(files, start, end) {
  let low = 0, high = files.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (files[middle].offset + files[middle].length <= start) low = middle + 1;
    else high = middle;
  }
  const result = [];
  for (let i = low; i < files.length && files[i].offset < end; i++) {
    if (files[i].length) result.push(files[i]);
  }
  return result;
}

async function readCandidate(sourceDir, expectedHash) {
  const original = await fsp.lstat(sourceDir);
  if (!original.isDirectory() || original.isSymbolicLink()) fail('Unsafe cache torrent directory');
  const torrent = decodeTorrent(await readSmall(path.join(sourceDir, 'cache'), LIMITS.torrentBytes));
  if (torrent.hash !== expectedHash.toLowerCase()) fail('Torrent info hash does not match cache directory');
  const bitBytes = Math.ceil(torrent.pieces.length / 20 / 8);
  const bitfield = await readSmall(path.join(sourceDir, 'bitfield'), bitBytes + 1);
  if (bitfield.length < bitBytes) fail('Missing or truncated bitfield');
  const available = (i) => Boolean(bitfield[Math.floor(i / 8)] & (128 >> (i % 8)));
  const stats = new Map();
  async function covers(start, end) {
    for (const file of intersecting(torrent.files, start, end)) {
      const needed = Math.min(end, file.offset + file.length) - file.offset;
      if (file.offset >= end || file.offset + file.length <= start) continue;
      if (!stats.has(file.index)) {
        try {
          const opened = await openRegular(path.join(sourceDir, String(file.index)), LIMITS.totalLength);
          stats.set(file.index, opened.stat); await opened.handle.close();
        } catch { stats.set(file.index, null); }
      }
      if (!stats.get(file.index) || stats.get(file.index).size < needed) return false;
    }
    return true;
  }
  const selected = [];
  for (const file of torrent.files) {
    if (!file.length || !VIDEO.test(file.path)) continue;
    const range = pieceRange(file, torrent);
    let complete = true;
    for (let p = range.start / torrent.pieceLength; p < Math.ceil(range.end / torrent.pieceLength); p++) {
      if (!available(p)) { complete = false; break; }
    }
    if (complete && await covers(range.start, range.end)) selected.push(file.index);
  }
  const current = await fsp.lstat(sourceDir);
  if (current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev) fail('Cache directory changed');
  return { ...torrent, selected, sourceDir, bitfield };
}

async function discover(cacheDir, options = {}) {
  let root;
  try { root = await rootDirectory(cacheDir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const candidates = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (!HASH.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const candidate = await readCandidate(path.join(root, entry.name), entry.name);
      if (candidate.selected.length) candidates.push(candidate);
    } catch (error) { if (typeof options.onError === 'function') options.onError(error, entry.name); }
  }
  return candidates;
}

function mergeRanges(ranges) {
  const result = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = result[result.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

async function readExact(handle, buffer, offset, length, position) {
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, offset + read, length - read, position + read);
    if (!result.bytesRead) fail('Cache file truncated during export');
    read += result.bytesRead;
  }
}

async function copyRanges(source, destination, ranges) {
  const opened = await openRegular(source, LIMITS.totalLength);
  try {
    // APFS reflinks isolate subsequent writes. Never hard-link mutable client data.
    if (ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === opened.stat.size) {
      try {
        await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE);
        const after = await fsp.lstat(source);
        if (after.isSymbolicLink() || after.ino !== opened.stat.ino || after.dev !== opened.stat.dev) fail('Cache file changed during clone');
        return;
      } catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EXDEV'].includes(error.code)) throw error;
      }
    }
    const output = await fsp.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (const range of ranges) {
        for (let pos = range.start; pos < range.end;) {
          const length = Math.min(buffer.length, range.end - pos);
          await readExact(opened.handle, buffer, 0, length, pos);
          let written = 0;
          while (written < length) {
            const result = await output.write(buffer, written, length - written, pos + written);
            if (!result.bytesWritten) fail('Unable to write export');
            written += result.bytesWritten;
          }
          pos += length;
        }
      }
      await output.sync();
    } finally { await output.close(); }
  } finally { await opened.handle.close(); }
}

async function verifyExport(torrent, root, ranges) {
  const buffer = Buffer.alloc(Math.min(torrent.pieceLength, 1024 * 1024));
  for (const range of ranges) {
    for (let start = range.start; start < range.end; start += torrent.pieceLength) {
      const end = Math.min(torrent.totalLength, start + torrent.pieceLength);
      const hash = crypto.createHash('sha1');
      for (const file of intersecting(torrent.files, start, end)) {
        const from = Math.max(start, file.offset), to = Math.min(end, file.offset + file.length);
        if (from >= to) continue;
        const { handle } = await openRegular(path.join(root, file.path), LIMITS.totalLength);
        try {
          for (let pos = from; pos < to;) {
            const length = Math.min(buffer.length, to - pos);
            await readExact(handle, buffer, 0, length, pos - file.offset);
            hash.update(buffer.subarray(0, length)); pos += length;
          }
        } finally { await handle.close(); }
      }
      const pieceIndex = start / torrent.pieceLength;
      if (!hash.digest().equals(torrent.pieces.subarray(pieceIndex * 20, (pieceIndex + 1) * 20))) fail(`Cached piece ${pieceIndex} failed SHA-1 verification`);
    }
  }
}

async function freeBytes(directory) {
  if (typeof fsp.statfs === 'function') {
    const space = await fsp.statfs(directory, { bigint: true });
    return space.bavail * space.bsize;
  }
  if (!['darwin', 'linux'].includes(process.platform)) fail('Cannot determine free disk space on this Node version/platform');
  const result = await execFile('/bin/df', ['-Pk', directory], {
    timeout: 5000, maxBuffer: 65536, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }
  });
  const lines = result.stdout.trim().split('\n').slice(1);
  if (lines.length !== 1) fail('Cannot parse free disk space');
  const match = /^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+/.exec(lines[0]);
  if (!match || match[1].length > 20) fail('Cannot parse free disk space');
  return BigInt(match[1]) * 1024n;
}

/** Export into an exclusively-created <destinationRoot>/<hash>. Existing targets
 * are always refused. For an existing paused torrent use a fresh staging parent,
 * then merge only returned ranges without truncating client-owned files. */
async function exportCandidate(candidate, destinationRoot, options = {}) {
  if (!candidate || !HASH.test(candidate.hash) || typeof candidate.sourceDir !== 'string' || !Array.isArray(candidate.selected)) fail('Invalid candidate');
  const sourceParent = await rootDirectory(path.dirname(candidate.sourceDir));
  const sourceDir = path.join(sourceParent, path.basename(candidate.sourceDir));
  if (path.basename(sourceDir).toLowerCase() !== candidate.hash.toLowerCase()) fail('Invalid source directory');
  const fresh = await readCandidate(sourceDir, candidate.hash);
  if (!Buffer.isBuffer(candidate.torrent) || !candidate.torrent.equals(fresh.torrent)) fail('Cached torrent changed');
  const selected = options.selected === undefined ? candidate.selected : options.selected;
  if (!Array.isArray(selected) || !selected.length || selected.some(i => !Number.isSafeInteger(i) || !fresh.selected.includes(i) || !candidate.selected.includes(i)) || new Set(selected).size !== selected.length) fail('Selected files are not complete cached videos');
  const ranges = mergeRanges(selected.map(i => pieceRange(fresh.files[i], fresh)));
  const files = fresh.files.map(file => ({ ...file, ranges: ranges.map(range => ({
    start: Math.max(range.start, file.offset) - file.offset,
    end: Math.min(range.end, file.offset + file.length) - file.offset
  })).filter(range => range.start < range.end) }));
  const root = await rootDirectory(destinationRoot, true);
  const savePath = path.join(root, fresh.hash);
  if (savePath === sourceDir || sourceDir.startsWith(savePath + path.sep) || root === sourceDir || root.startsWith(sourceDir + path.sep)) fail('Export destination overlaps cache');
  // Reserve worst-case full logical lengths: sparse boundary files may become
  // fully allocated by a client. Cloning is treated as an optimization only.
  const requiredBytes = files.filter(file => file.ranges.length).reduce((sum, file) => sum + file.length, 0);
  const minFreeBytes = options.minFreeBytes === undefined ? 256 * 1024 * 1024 : integer(options.minFreeBytes, Number.MAX_SAFE_INTEGER, 'minimum free bytes');
  if (await freeBytes(root) < BigInt(requiredBytes) + BigInt(minFreeBytes)) fail('Insufficient free disk space for safe export');
  await fsp.mkdir(savePath, { mode: 0o700 }); // EEXIST deliberately propagates.
  try {
    for (const file of files) {
      if (!file.ranges.length) continue;
      const destination = path.join(savePath, file.path);
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyRanges(path.join(sourceDir, String(file.index)), destination, file.ranges);
    }
    await verifyExport(fresh, savePath, ranges);
    return { hash: fresh.hash, torrent: fresh.torrent, savePath, selected: [...selected], files,
      name: fresh.name, multiFile: fresh.multiFile, totalLength: fresh.totalLength,
      pieceLength: fresh.pieceLength, requiredBytes };
  } catch (error) {
    await fsp.rm(savePath, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { discover, exportCandidate, decodeTorrent };
