'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function appData() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Seme', 'integration');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Seme', 'integration');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'seme', 'integration');
}

function configPath() { return process.env.SEME_CONFIG_PATH || path.join(appData(), 'config.json'); }

function stremioSettingsPath() {
  if (process.env.SETTINGS_PATH) return path.join(process.env.SETTINGS_PATH, 'server-settings.json');
  if (process.env.APP_PATH) return path.join(process.env.APP_PATH, 'server-settings.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'stremio-server', 'server-settings.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'stremio', 'stremio-server', 'server-settings.json');
  return path.join(os.homedir(), '.stremio-server', 'server-settings.json');
}

function defaultConfig() {
  const settings = stremioSettingsPath();
  const cacheRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Stremio') : path.dirname(settings);
  return {
    enabled: true,
    cacheDir: path.join(cacheRoot, 'stremio-cache'),
    destinationDir: path.join(os.homedir(), 'Downloads', 'Seme'),
    minFreeBytes: 2 * 1024 ** 3,
    intervalSeconds: 30,
    client: { type: 'transmission', url: 'http://127.0.0.1:9091/transmission/rpc', username: '', password: '' },
  };
}

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid integration configuration.');
  const config = { ...defaultConfig(), ...input, client: { ...defaultConfig().client, ...input.client } };
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  for (const key of ['cacheDir', 'destinationDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || config[key].includes('\0')) throw new Error(`${key} must be an absolute folder path.`);
    config[key] = path.resolve(config[key]);
    if (config[key] === path.parse(config[key]).root) throw new Error(`${key} cannot be the filesystem root.`);
  }
  if (overlaps(config.cacheDir, config.destinationDir) || overlaps(config.destinationDir, config.cacheDir)) {
    throw new Error('The cache and preservation folders must be separate, not nested.');
  }
  if (!Number.isSafeInteger(config.minFreeBytes) || config.minFreeBytes < 0) throw new Error('minFreeBytes must be a non-negative integer.');
  if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 5 || config.intervalSeconds > 3600) throw new Error('intervalSeconds must be between 5 and 3600.');
  if (!['transmission', 'qbittorrent', 'deluge'].includes(config.client.type)) throw new Error('Choose Transmission, qBittorrent or Deluge.');
  let url;
  try { url = new URL(config.client.url); } catch { throw new Error('Invalid client URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) client URL without credentials, query or fragment.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('This integration requires a torrent client on this computer (localhost).');
  for (const key of ['username', 'password']) if (typeof config.client[key] !== 'string') throw new Error(`Client ${key} must be text.`);
  config.client.url = url.href.replace(/\/$/, '');
  return config;
}

async function loadConfig(file = configPath()) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) throw new Error('Invalid configuration file.');
  return validateConfig(JSON.parse(await fs.readFile(file, 'utf8')));
}

// A separate function keeps defaultConfig synchronous for the setup application.
async function detectedDefaults() {
  const config = defaultConfig();
  try {
    const settings = JSON.parse(await fs.readFile(stremioSettingsPath(), 'utf8'));
    if (typeof settings.cacheRoot === 'string' && path.isAbsolute(settings.cacheRoot)) config.cacheDir = path.join(settings.cacheRoot, 'stremio-cache');
  } catch { /* Stremio may never have been opened. */ }
  return config;
}

async function privateDirectory(directory) {
  let current = path.parse(path.resolve(directory)).root;
  for (const component of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current);
    const systemAlias = process.platform === 'darwin' && ['/tmp', '/var'].includes(current)
      && await fs.realpath(current) === '/private' + current;
    if ((!stat.isDirectory() || stat.isSymbolicLink()) && !systemAlias) throw new Error('Folders must not contain symbolic links.');
  }
}

async function atomicFile(file, bytes) {
  await privateDirectory(path.dirname(file));
  try { const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error('State file must be a regular file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temp).catch(() => {}); }
}

async function atomicJSON(file, value) { return atomicFile(file, JSON.stringify(value, null, 2) + '\n'); }

async function saveConfig(config, file = configPath()) {
  const validated = validateConfig(config);
  await atomicJSON(file, validated);
  return validated;
}

module.exports = { configPath, defaultConfig, detectedDefaults, validateConfig, loadConfig, saveConfig, atomicJSON, atomicFile, privateDirectory, overlaps };
