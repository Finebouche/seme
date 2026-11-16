'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
const TEAM = 'BH62GT22G7';
const IDENTIFIER = 'com.westbridge.stremio5-mac';
const trust = 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "' + TEAM + '"';
const REQUIREMENT = 'identifier "' + IDENTIFIER + '" and ' + trust;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function regularPath(file, directory = false) {
  let current = path.resolve(file), first = true;
  while (true) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (first ? (directory ? !stat.isDirectory() : !stat.isFile()) : !stat.isDirectory())) throw new Error('Official Stremio verification requires regular, symlink-free bundle paths.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent; first = false;
  }
}

// plutil normalizes the resource envelope to XML. Parse only plist primitives,
// with explicit size/depth bounds and no entity expansion or external loading.
function parsePlist(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 4 * 1024 * 1024) throw new Error('Invalid Stremio resource seal.');
  let source = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '').replace(/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/, '');
  let offset = 0, count = 0;
  function skip() { while (/\s/.test(source[offset] || '') && offset < source.length) offset++; }
  function take(value) { skip(); if (!source.startsWith(value, offset)) throw new Error('Invalid Stremio resource seal.'); offset += value.length; }
  function text(tag) {
    take('<' + tag + '>'); const end = source.indexOf('</' + tag + '>', offset);
    if (end < 0) throw new Error('Invalid Stremio resource seal.');
    const raw = source.slice(offset, end); offset = end + tag.length + 3;
    if (raw.includes('<') || /&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) throw new Error('Invalid Stremio resource seal.');
    return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]);
  }
  function value(depth) {
    if (depth > 32 || ++count > 100000) throw new Error('Invalid Stremio resource seal.');
    skip();
    if (source.startsWith('<dict>', offset)) {
      take('<dict>'); const result = Object.create(null);
      while (true) {
        skip(); if (source.startsWith('</dict>', offset)) break;
        const key = text('key'); if (Object.hasOwn(result, key)) throw new Error('Invalid Stremio resource seal.');
        result[key] = value(depth + 1);
      }
      take('</dict>'); return result;
    }
    if (source.startsWith('<array>', offset)) {
      take('<array>'); const result = [];
      while (true) { skip(); if (source.startsWith('</array>', offset)) break; result.push(value(depth + 1)); }
      take('</array>'); return result;
    }
    for (const tag of ['string', 'integer', 'real', 'date']) if (source.startsWith('<' + tag + '>', offset)) return text(tag);
    if (source.startsWith('<data>', offset)) {
      const data = text('data').replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid Stremio resource seal.');
      return Buffer.from(data, 'base64');
    }
    for (const [tag, result] of [['true', true], ['false', false]]) if (source.startsWith('<' + tag + '/>', offset)) { take('<' + tag + '/>'); return result; }
    for (const [tag, result] of [['dict', Object.create(null)], ['array', []], ['string', ''], ['data', Buffer.alloc(0)]]) if (source.startsWith('<' + tag + '/>', offset)) { take('<' + tag + '/>'); return result; }
    throw new Error('Invalid Stremio resource seal.');
  }
  take('<plist version="1.0">'); const result = value(0); take('</plist>'); skip();
  if (offset !== source.length) throw new Error('Invalid Stremio resource seal.');
  return result;
}

async function verifyOfficialUpdate(server, expectedHash, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') throw new Error('Automatic Stremio update verification requires macOS. Use --accept-update only after inspecting a known clean upstream update.');
  const target = path.resolve(server), bundle = path.resolve(target, '../../..');
  if (!bundle.endsWith('.app') || target !== path.join(bundle, 'Contents', 'MacOS', 'server.js')) throw new Error('Automatic updates require server.js at its official Contents/MacOS/server.js bundle location.');
  const info = path.join(bundle, 'Contents', 'Info.plist'), resources = path.join(bundle, 'Contents', '_CodeSignature', 'CodeResources');
  await regularPath(bundle, true); await regularPath(target); await regularPath(info); await regularPath(resources);
  const before = await fs.readFile(target), infoBefore = await fs.readFile(info), sealBefore = await fs.readFile(resources);
  if (sha256(before) !== expectedHash) throw new Error('Stremio changed during update verification. No patch applied.');
  const deadline = Date.now() + 90000;
  async function run(file, args, maximum = 15000) {
    const timeout = Math.min(maximum, deadline - Date.now());
    if (timeout <= 0) throw new Error('Stremio signature verification timed out.');
    return (options.run || execute)(file, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  }
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=' + REQUIREMENT, bundle], 60000);
    const envelope = parsePlist((await run('/usr/bin/plutil', ['-extract', 'files2', 'xml1', '-o', '-', resources])).stdout);
    const entry = envelope['MacOS/server.js'];
    if (!entry || Buffer.isBuffer(entry) || typeof entry !== 'object' || entry.optional || entry.omit || entry.symlink) throw new Error('Stremio server.js is not a mandatory sealed resource.');
    if (Buffer.isBuffer(entry.hash2)) {
      if (entry.hash2.length !== 32 || entry.hash2.toString('hex') !== expectedHash) throw new Error('Stremio server.js does not match its resource seal.');
    } else if (Buffer.isBuffer(entry.cdhash) && entry.cdhash.length === 20 && typeof entry.requirement === 'string') {
      // Current Stremio distributions seal server.js as separately signed code.
      // Check its official signer as well as the CDHash authenticated by the app.
      await run('/usr/bin/codesign', ['--verify', '--strict', '-R', '=identifier "server" and ' + trust, target]);
      const detail = await run('/usr/bin/codesign', ['--display', '--verbose=4', target]);
      const matches = [...(detail.stderr || '').matchAll(/^CDHash=([a-fA-F0-9]{40})\s*$/gm)];
      if (matches.length !== 1 || matches[0][1].toLowerCase() !== entry.cdhash.toString('hex')) throw new Error('Stremio server.js does not match its signed code seal.');
    } else throw new Error('Stremio server.js has no supported mandatory resource seal.');
    async function field(key) { return (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info])).stdout.trim(); }
    const bundleIdentifier = await field('CFBundleIdentifier'), version = await field('CFBundleShortVersionString');
    if (bundleIdentifier !== IDENTIFIER || !/^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(version)) throw new Error('Unexpected official Stremio bundle metadata.');
    await regularPath(target); await regularPath(info); await regularPath(resources);
    if (!(await fs.readFile(target)).equals(before) || !(await fs.readFile(info)).equals(infoBefore) || !(await fs.readFile(resources)).equals(sealBefore)) throw new Error('Stremio changed during update verification. No patch applied.');
    return { version, teamIdentifier: TEAM, bundleIdentifier };
  } catch (error) {
    // Never surface arbitrary tool output (which may include user-controlled data).
    if (/^Stremio (?:server\.js|changed|signature)|^Unexpected official Stremio|^Invalid Stremio/.test(error.message)) throw error;
    throw new Error('Stremio official signature verification failed. No files changed. Reinstall the official app or inspect a known clean update before using --accept-update.');
  }
}
module.exports = { verifyOfficialUpdate, REQUIREMENT, TEAM, IDENTIFIER, parsePlist };
