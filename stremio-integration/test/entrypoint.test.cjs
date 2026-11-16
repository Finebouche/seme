'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.cjs'), 'utf8');

test('companion bind failure leaves cache transfers running and does not reject the host', async () => {
  let starts = 0, stops = 0;
  const messages = [];
  const context = vm.createContext({ global: {}, Symbol, Promise, console: { error: message => messages.push(message) },
    require: name => name === './lib/runtime.cjs'
      ? { start() { starts++; return { stop() { stops++; } }; } }
      : { start() { return { ready: Promise.reject(new Error('occupied port')), stop: async () => {} }; } },
  });
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(stops, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /cache transfers continue/);
  await context.global[Symbol.for('seme.stremio.integration')].stop();
  assert.equal(stops, 1);
});

test('missing companion code does not prevent host startup or transfer shutdown', async () => {
  let stopped = false;
  const context = vm.createContext({ global: {}, Symbol, Promise, console: { error() {} }, require: name => {
    if (name === './lib/runtime.cjs') return { start: () => ({ stop() { stopped = true; } }) };
    throw new Error('missing addon');
  } });
  assert.doesNotThrow(() => vm.runInContext(source, context));
  await context.global[Symbol.for('seme.stremio.integration')].stop();
  assert.equal(stopped, true);
});
