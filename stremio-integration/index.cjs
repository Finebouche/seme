'use strict';

// Transfers and the companion add-on share Stremio's existing Node process.
// A broken/missing Sème installation must never prevent Stremio from starting.
try {
  const key = Symbol.for('seme.stremio.integration');
  if (!global[key]) {
    const transfers = require('./lib/runtime.cjs').start();
    let addon;
    global[key] = { stop() { transfers.stop(); return addon ? addon.stop() : Promise.resolve(); } };
    try {
      addon = require('./lib/addon.cjs').start();
      addon.ready.catch(() => console.error('[Sème] Configuration page unavailable; cache transfers continue.'));
    } catch (_) {
      console.error('[Sème] Configuration page unavailable; cache transfers continue.');
    }
  }
} catch (_) {
  console.error('[Sème] Integration unavailable; Stremio continues normally.');
}
