'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/install.cjs');
const { verifyOfficialUpdate, REQUIREMENT, parsePlist } = require('../lib/vendor.cjs');
const header = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">';
const plist = body => header + body + '</plist>';
const data = value => '<data>' + value.toString('base64') + '</data>';
async function fixture(t, extra = '') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seme-vendor-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Stremio.app'), server = path.join(bundle, 'Contents', 'MacOS', 'server.js');
  const info = path.join(bundle, 'Contents', 'Info.plist'), resources = path.join(bundle, 'Contents', '_CodeSignature', 'CodeResources');
  await fs.mkdir(path.dirname(server), { recursive: true }); await fs.mkdir(path.dirname(resources));
  const bytes = Buffer.from('// official upstream version\n'); await fs.writeFile(server, bytes);
  await fs.writeFile(info, 'sealed Info.plist'); await fs.writeFile(resources, 'sealed CodeResources');
  const calls = [];
  let envelope = plist('<dict><key>MacOS/server.js</key><dict><key>hash2</key>' + data(Buffer.from(hash(bytes), 'hex')) + extra + '</dict></dict>');
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.encoding, 'utf8'); assert.ok(options.timeout > 0 && options.timeout <= 60000); assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: 'CDHash=' + 'a'.repeat(40) + '\n' };
    assert.equal(file, '/usr/bin/plutil');
    if (args[1] === 'files2') return { stdout: envelope };
    if (args[1] === 'CFBundleIdentifier') return { stdout: 'com.westbridge.stremio5-mac\n' };
    if (args[1] === 'CFBundleShortVersionString') return { stdout: '5.1.0\n' };
    throw new Error('Unexpected command');
  };
  return { root, bundle, server, bytes, info, resources, calls, run, envelope: value => { envelope = value; } };
}

test('official update verifies entire bundle against pinned Apple Developer ID identity and authenticates sealed server bytes and metadata', async t => {
  const f = await fixture(t);
  const result = await verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: f.run });
  assert.deepEqual(result, { version: '5.1.0', teamIdentifier: 'BH62GT22G7', bundleIdentifier: 'com.westbridge.stremio5-mac' });
  assert.deepEqual(f.calls[0].args, ['--verify', '--deep', '--strict', '-R', '=' + REQUIREMENT, f.bundle]);
  assert.match(REQUIREMENT, /anchor apple generic/); assert.match(REQUIREMENT, /1\.2\.840\.113635\.100\.6\.2\.6/); assert.match(REQUIREMENT, /1\.2\.840\.113635\.100\.6\.1\.13/);
  assert.match(REQUIREMENT, /BH62GT22G7/); assert.match(REQUIREMENT, /com\.westbridge\.stremio5-mac/);
});

test('signature failure or wrong official identity fails closed with bounded diagnostics', async t => {
  const f = await fixture(t);
  for (const reason of ['signature invalid secret', 'wrong TeamIdentifier secret']) {
    await assert.rejects(verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: async () => { throw new Error(reason); } }), error => {
      assert.match(error.message, /official signature verification failed/); assert.ok(!error.message.includes('secret')); return true;
    });
  }
});

test('macOS accepts the literal requirements passed to codesign', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  f.envelope(plist('<dict><key>MacOS/server.js</key><dict><key>cdhash</key>' + data(Buffer.from('a'.repeat(40), 'hex')) + '<key>requirement</key><string>nested code</string></dict></dict>'));
  await verifyOfficialUpdate(f.server, hash(f.bytes), { run: f.run });
  for (const call of f.calls.filter(call => call.args.includes('-R'))) {
    const requirement = call.args[call.args.indexOf('-R') + 1];
    assert.ok(requirement.startsWith('='), 'codesign needs = to distinguish a literal from a file path');
    execFileSync('/usr/bin/csreq', ['-r', requirement, '-b', path.join(f.root, 'requirement.bin')], { timeout: 10000 });
  }
});

test('missing, optional, omitted, symbolic and mismatched server seals are refused despite a valid whole-app signature result', async t => {
  const f = await fixture(t);
  const hashEntry = '<key>hash2</key>' + data(Buffer.from(hash(f.bytes), 'hex'));
  for (const body of ['', '<key>MacOS/server.js</key><dict/>', ...['optional', 'omit', 'symlink'].map(key => '<key>MacOS/server.js</key><dict>' + hashEntry + '<key>' + key + '</key><true/></dict>'), '<key>MacOS/server.js</key><dict><key>hash2</key>' + data(Buffer.alloc(32)) + '</dict>']) {
    f.envelope(plist('<dict>' + body + '</dict>'));
    await assert.rejects(verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: f.run }), /seal/);
  }
});

test('current nested-code seal must match separately verified official server CDHash', async t => {
  const f = await fixture(t);
  f.envelope(plist('<dict><key>MacOS/server.js</key><dict><key>cdhash</key>' + data(Buffer.from('a'.repeat(40), 'hex')) + '<key>requirement</key><string>sealed nested code requirement</string></dict></dict>'));
  await verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: f.run });
  assert.ok(f.calls.some(call => call.args.includes('=identifier "server" and ' + REQUIREMENT.split(' and ').slice(1).join(' and '))));
  await assert.rejects(verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: async (...args) => {
    const result = await f.run(...args); if (args[1][0] === '--display') return { stderr: 'CDHash=' + 'b'.repeat(40) + '\n' }; return result;
  } }), /signed code seal/);
});

test('bundle paths, metadata and changes during verification fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'linux', run: f.run }), /requires macOS/);
  await assert.rejects(verifyOfficialUpdate(f.info, hash(f.bytes), { platform: 'darwin', run: f.run }), /official Contents/);
  const link = path.join(f.root, 'linked.app'); await fs.symlink(f.bundle, link);
  await assert.rejects(verifyOfficialUpdate(path.join(link, 'Contents', 'MacOS', 'server.js'), hash(f.bytes), { platform: 'darwin', run: f.run }), /symlink-free/);
  await assert.rejects(verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: async (...args) => {
    const result = await f.run(...args); if (args[1][1] === 'CFBundleIdentifier') return { stdout: 'org.other.app' }; return result;
  } }), /Unexpected official/);
  for (const target of [f.server, f.info, f.resources]) {
    const before = await fs.readFile(target);
    await assert.rejects(verifyOfficialUpdate(f.server, hash(f.bytes), { platform: 'darwin', run: async (...args) => {
      const result = await f.run(...args); if (args[1][1] === 'CFBundleShortVersionString') await fs.appendFile(target, 'changed'); return result;
    } }), /changed during update verification/);
    await fs.writeFile(target, before);
  }
});

test('resource seal XML parser rejects duplicate keys, entities, malformed and oversized data', () => {
  for (const xml of [plist('<dict><key>a</key><true/><key>a</key><false/></dict>'), plist('<string>&custom;</string>'), plist('<data>invalid!</data>'), '<!DOCTYPE plist [<!ENTITY x "evil">]>' + plist('<dict/>'), ' '.repeat(4 * 1024 * 1024 + 1)]) assert.throws(() => parsePlist(xml), /Invalid Stremio/);
});
