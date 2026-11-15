#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const config = require('./lib/config.cjs');
const installer = require('./lib/install.cjs');
function argumentsFor(args) {
  const result = { command: args[0] || 'status', server: '/Applications/Stremio.app/Contents/MacOS/server.js', configFile: config.configPath() };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) result.server = path.resolve(args[++i]);
    else if (args[i] === '--config' && args[i + 1]) result.configFile = path.resolve(args[++i]);
    else if (args[i] === '--accept-update') result.acceptUpdate = true;
    else throw new Error('Unknown option. Credentials must be provided through JSON on stdin, never command arguments.');
  }
  return result;
}
async function stdinJSON(required) {
  if (process.stdin.isTTY) { if (required) throw new Error('Provide configuration JSON on stdin.'); return null; }
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error('Configuration input is too large.'); }
  if (!input.trim() && !required) return null;
  try { return JSON.parse(input); } catch (_) { throw new Error('Invalid configuration JSON.'); }
}
async function runtimeStatus(file) {
  try {
    const statusFile = path.join(path.dirname(file), 'status.json');
    const stat = await fs.promises.lstat(statusFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null;
    const raw = JSON.parse(await fs.promises.readFile(statusFile, 'utf8'));
    const timestamp = typeof raw.lastScan === 'string' && Number.isFinite(Date.parse(raw.lastScan)) ? new Date(raw.lastScan).toISOString() : null;
    return { lastScan: timestamp, imported: Number.isSafeInteger(raw.imported) && raw.imported >= 0 ? raw.imported : 0,
      skipped: Number.isSafeInteger(raw.skipped) && raw.skipped >= 0 ? raw.skipped : 0, enabled: raw.enabled === true,
      errors: (Array.isArray(raw.errors) ? raw.errors : []).filter(error => error && typeof error === 'object').slice(0, 20).map(error => ({
        code: typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'RUNTIME_ERROR',
        hash: typeof error.hash === 'string' && /^[a-f0-9]{40}$/i.test(error.hash) ? error.hash : null,
      })) };
  } catch (_) { return null; }
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  switch (options.command) {
    case 'status': return { ...(await installer.status(options)), runtime: await runtimeStatus(options.configFile) };
    case 'defaults': return { ok: true, defaults: await config.detectedDefaults() };
    case 'preview': {
      const result = await installer.status(options);
      return { ...result, plannedAction: result.state === 'installed' ? 'Refresh the private integration module; server.js already matches.' : 'Back up server.js exactly, copy the private module, and prepend the Sème hook.', backupDirectory: installer.locations(options.server, options.configFile).state };
    }
    case 'install': return installer.install(options);
    case 'uninstall': return installer.uninstall(options);
    case 'configure': {
      await config.saveConfig(await stdinJSON(true), options.configFile);
      return { ok: true, message: 'Configuration saved.', configFile: options.configFile };
    }
    case 'validate': {
      const supplied = await stdinJSON(false);
      if (supplied) config.validateConfig(supplied);
      else await config.loadConfig(options.configFile);
      return { ok: true, message: 'Configuration is valid.' };
    }
    case 'test-client': {
      const supplied = await stdinJSON(false);
      const value = config.validateConfig(supplied || await config.loadConfig(options.configFile));
      const clients = require('./lib/clients.cjs');
      const result = await clients.createClient(value.client).test();
      if (result && result.storage && result.storage.separateIncompleteDirectory) {
        const error = new Error('Separate incomplete directory is unsupported.'); error.code = 'UNSUPPORTED_STORAGE'; throw error;
      }
      return { ok: true, message: 'Torrent client connection succeeded.' };
    }
    default: throw new Error('Commands: status, preview, install, uninstall, configure, validate, test-client.');
  }
}
main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  // Only known installer/config errors may be descriptive; remote client failures can include credentials.
  const message = process.argv[2] === 'test-client' ? (error.code === 'UNSUPPORTED_STORAGE'
    ? 'Connected, but the client uses a separate incomplete folder. Disable that setting before using Sème (UNSUPPORTED_STORAGE).'
    : 'Torrent client connection failed. Check its address and credentials.') : (error instanceof SyntaxError ? 'Stored JSON data is invalid.' : String(error.message || 'Operation failed.'));
  process.stdout.write(JSON.stringify({ ok: false, error: message.slice(0, 600), code: error.code === 'UNSUPPORTED_STORAGE' ? error.code : undefined }) + '\n');
  process.exitCode = 1;
});
