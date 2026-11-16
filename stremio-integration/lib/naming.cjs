'use strict';

const fs = require('fs/promises');
const path = require('path');

const MAX_NAME_BYTES = 180;
const HASH = /^[0-9a-f]{40}$/;
const VIDEO_EXTENSION = /\.(?:mkv|mp4|avi|mov|wmv|webm|m4v|mpg|mpeg|m2ts|mts|ts|vob|ogv|flv)$/i;
const FORBIDDEN = /[<>:"/\\|?*\p{Cc}\p{Cf}]/gu;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function truncate(value, bytes) {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > bytes) break;
    result += character;
  }
  return result.replace(/[ .]+$/u, '');
}

function destinationName(name, options = {}) {
  let result = typeof name === 'string' ? name.normalize('NFC') : '';
  if (options.singleFile) result = result.replace(VIDEO_EXTENSION, '');
  result = result.replace(FORBIDDEN, ' ').replace(/\s+/gu, ' ').replace(/^[ .]+|[ .]+$/gu, '');
  if (!result) result = 'Torrent';
  if (RESERVED.test(result)) result = `Torrent ${result}`;
  return truncate(result, MAX_NAME_BYTES) || 'Torrent';
}

function isDestinationName(name) {
  return typeof name === 'string' && !!name && Buffer.byteLength(name) <= MAX_NAME_BYTES
    && !/^[ .]|[ .]$/u.test(name) && !RESERVED.test(name)
    && !/[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name);
}

// The configured root is canonicalized by runtime. Reject even lexically
// equivalent paths containing '..': filesystem symlinks can change their meaning.
function isDestinationPath(root, candidate) {
  return typeof root === 'string' && typeof candidate === 'string'
    && path.isAbsolute(candidate) && candidate === path.resolve(candidate)
    && path.dirname(candidate) === path.resolve(root) && isDestinationName(path.basename(candidate));
}

function collisionKey(name) { return name.normalize('NFC').toLowerCase(); }

// Selection is read-only. Callers must reserve the result with exclusive mkdir
// and retry on EEXIST before writing data. Include files and symlinks as occupied,
// and compare normalized names without case to remain portable across volumes.
async function chooseDestination(root, name, hash, options = {}) {
  if (!HASH.test(hash)) { const error = new Error('INVALID_HASH'); error.code = 'INVALID_HASH'; throw error; }
  const base = destinationName(name, options);
  const occupied = new Set((await fs.readdir(root)).filter(entry => !options.excludePath || path.join(root, entry) !== options.excludePath).map(collisionKey));
  const available = value => !occupied.has(collisionKey(value));
  if (available(base)) return path.join(root, base);
  for (let length = 8; length <= hash.length; length += 4) {
    const suffix = ` [${hash.slice(0, length)}]`;
    const value = truncate(base, MAX_NAME_BYTES - Buffer.byteLength(suffix)) + suffix;
    if (available(value)) return path.join(root, value);
  }
  const error = new Error('DESTINATION_EXISTS'); error.code = 'DESTINATION_EXISTS'; throw error;
}

module.exports = { MAX_NAME_BYTES, destinationName, isDestinationName, isDestinationPath, chooseDestination };
