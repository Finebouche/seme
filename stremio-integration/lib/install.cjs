'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const BEGIN = '// BEGIN SEME STREMIO INTEGRATION v1';
const END = '// END SEME STREMIO INTEGRATION v1';
const SIGNATURE_NOTICE = 'Changing server.js invalidates the Stremio app code signature. Sème does not re-sign Stremio. macOS may refuse to launch the modified app; reinstalling Stremio or restoring the exact backup restores its original resources.';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function locations(server, configFile) {
  const resolved = path.resolve(server);
  const base = path.dirname(path.resolve(configFile));
  return { server: resolved, module: path.join(base, 'module'), state: path.join(base, 'installations', hash(resolved)) };
}
async function regular(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Target must be a regular file, never a symbolic link.');
  // Also reject symlinked parent directories: atomic rename must affect the inspected target.
  let parent = path.dirname(path.resolve(file));
  while (true) {
    if ((await fsp.lstat(parent)).isSymbolicLink()) throw new Error('Target parent directories must not be symbolic links.');
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  return stat;
}
async function atomicWrite(file, bytes, mode) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.seme-' + crypto.randomBytes(8).toString('hex'));
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', mode);
    await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); await handle.close(); handle = null;
    await fsp.rename(temp, file);
  } finally {
    if (handle) await handle.close();
    await fsp.unlink(temp).catch(() => {});
  }
}
async function readManifest(state) {
  try { return JSON.parse(await fsp.readFile(path.join(state, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Installation manifest cannot be read.'); }
}
async function activeServer(server) {
  try {
    const result = await run('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 2 * 1024 * 1024 });
    const bundle = path.dirname(server);
    return result.stdout.split('\n').some(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || Number(match[1]) === process.pid || Number(match[1]) === process.ppid) return false;
      return match[2].includes(server) || match[2].includes(path.join(bundle, 'node') + ' ');
    });
  } catch (_) { throw new Error('Cannot check whether the Stremio server is running. Quit Stremio before retrying.'); }
}
async function status(options) {
  const loc = locations(options.server, options.configFile);
  const stat = await regular(loc.server);
  const bytes = await fsp.readFile(loc.server);
  const currentHash = hash(bytes);
  const manifest = await readManifest(loc.state);
  let state = 'not-installed';
  if (manifest) {
    if (manifest.server !== loc.server || !/^[a-f0-9]{64}$/.test(manifest.originalHash || '') || !/^[a-f0-9]{64}$/.test(manifest.patchedHash || '')) throw new Error('Invalid installation manifest.');
    if (currentHash === manifest.patchedHash) state = 'installed';
    else if (currentHash === manifest.originalHash) state = 'restored';
    else state = 'changed';
  } else if (bytes.includes(Buffer.from(BEGIN))) state = 'unknown-hook';
  let running = null;
  try { running = await (options.processProbe || activeServer)(loc.server); } catch (_) { /* Status remains useful in restricted environments. */ }
  return { state, processCheck: running === null ? 'unavailable' : 'available', server: loc.server, module: loc.module, running, restartRequired: state === 'installed', signatureNotice: SIGNATURE_NOTICE, currentHash, mode: stat.mode & 0o7777 };
}
function patch(original, moduleFile, configFile) {
  const code = BEGIN + '\ntry { process.env.SEME_CONFIG_PATH = ' + JSON.stringify(path.resolve(configFile)) + '; require(' + JSON.stringify(moduleFile) + '); } catch (_) { console.error("[Seme] Integration could not start."); }\n' + END + '\n';
  if (original.subarray(0, 2).toString() !== '#!') return Buffer.concat([Buffer.from(code), original]);
  const newline = original.indexOf(10);
  if (newline < 0) return Buffer.concat([original, Buffer.from('\n' + code)]);
  return Buffer.concat([original.subarray(0, newline + 1), Buffer.from(code), original.subarray(newline + 1)]);
}
async function copyModule(source, destination) {
  const relative = path.relative(path.resolve(source), path.resolve(destination));
  if (relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Installed runtime must be outside the runtime source folder.');
  const parent = path.dirname(destination);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = destination + '.stage-' + crypto.randomBytes(8).toString('hex');
  const old = destination + '.old-' + crypto.randomBytes(8).toString('hex');
  await fsp.mkdir(stage, { mode: 0o700 });
  try {
    async function copy(from, to) {
      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        if (['test', 'macos', 'node_modules', '.DS_Store'].includes(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) throw new Error('Runtime source cannot contain symbolic links.');
        const src = path.join(from, entry.name), dst = path.join(to, entry.name);
        if (entry.isDirectory()) { await fsp.mkdir(dst, { mode: 0o700 }); await copy(src, dst); }
        else if (entry.isFile() && /\.(cjs|json|md)$/.test(entry.name)) { await fsp.copyFile(src, dst); await fsp.chmod(dst, 0o600); }
      }
    }
    await copy(source, stage);
    if (!fs.existsSync(path.join(stage, 'index.cjs'))) throw new Error('Integration runtime is missing index.cjs.');
    if (fs.existsSync(destination)) {
      const st = await fsp.lstat(destination); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Runtime destination must be a regular directory.');
      await fsp.rename(destination, old);
    }
    try { await fsp.rename(stage, destination); }
    catch (error) { if (fs.existsSync(old)) await fsp.rename(old, destination); throw error; }
    await fsp.rm(old, { recursive: true, force: true });
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
}
async function install(options) {
  const before = await status(options);
  if (before.running === null) throw new Error('Cannot check Stremio processes. Run setup outside this restricted environment after quitting Stremio.');
  if (before.running) throw new Error('Quit Stremio completely before installing.');
  if (before.state === 'unknown-hook') throw new Error('An unrecognized Sème hook is present. Restore Stremio before installing.');
  if (before.state === 'changed' && !options.acceptUpdate) throw new Error('Stremio server.js changed since installation. No files changed. Inspect it, then use --accept-update only for a known clean upstream update.');
  const loc = locations(options.server, options.configFile);
  const original = await fsp.readFile(loc.server);
  if (before.state === 'changed' && (original.includes(Buffer.from(BEGIN)) || original.includes(Buffer.from(END)))) throw new Error('Changed file still contains a Sème hook; refusing to adopt it.');
  // An already installed exact patch can safely refresh the runtime without touching server.js.
  await copyModule(options.sourceDir || path.resolve(__dirname, '..'), loc.module);
  if (before.state === 'installed') return { ...before, unchanged: true };
  const patched = patch(original, path.join(loc.module, 'index.cjs'), options.configFile);
  await fsp.mkdir(loc.state, { recursive: true, mode: 0o700 });
  const originalHash = hash(original), backup = path.join(loc.state, originalHash + '.original');
  try { await fsp.writeFile(backup, original, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (hash(await fsp.readFile(backup)) !== originalHash) throw new Error('Backup checksum mismatch.'); }
  const manifest = { version: 1, server: loc.server, originalHash, patchedHash: hash(patched), mode: before.mode, installedAt: new Date().toISOString() };
  // Verify immediately before replacement; all writes remain on the same filesystem.
  if (hash(await fsp.readFile(loc.server)) !== before.currentHash) throw new Error('Stremio changed during installation. No patch applied.');
  await regular(loc.server);
  await atomicWrite(path.join(loc.state, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o600);
  await atomicWrite(loc.server, patched, before.mode);
  return { ...(await status(options)), unchanged: false };
}
async function uninstall(options) {
  const before = await status(options);
  if (before.running === null) throw new Error('Cannot check Stremio processes. Run setup outside this restricted environment after quitting Stremio.');
  if (before.running) throw new Error('Quit Stremio completely before uninstalling.');
  if (before.state === 'not-installed' || before.state === 'restored') return { ...before, unchanged: true };
  if (before.state !== 'installed') throw new Error('Stremio server.js changed. Refusing to overwrite it with a stale backup.');
  const loc = locations(options.server, options.configFile), manifest = await readManifest(loc.state);
  const original = await fsp.readFile(path.join(loc.state, manifest.originalHash + '.original'));
  if (hash(original) !== manifest.originalHash) throw new Error('Backup checksum mismatch. No files changed.');
  if (hash(await fsp.readFile(loc.server)) !== manifest.patchedHash) throw new Error('Stremio changed during uninstall. No files changed.');
  await regular(loc.server);
  await atomicWrite(loc.server, original, manifest.mode);
  return { ...(await status(options)), unchanged: false };
}
async function locked(options, operation) {
  const loc = locations(options.server, options.configFile);
  await fsp.mkdir(loc.state, { recursive: true, mode: 0o700 });
  const directory = await fsp.lstat(loc.state);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Installation state must be a regular private directory.');
  await fsp.chmod(loc.state, 0o700);
  const lock = path.join(loc.state, 'operation.lock');
  let handle;
  try { handle = await fsp.open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another setup operation is in progress. If setup previously crashed, inspect and remove its operation.lock file.'); throw error; }
  try { return await operation(options); }
  finally { await handle.close(); await fsp.unlink(lock); }
}
module.exports = { BEGIN, END, SIGNATURE_NOTICE, locations, hash, patch, status,
  install: options => locked(options, install), uninstall: options => locked(options, uninstall) };

