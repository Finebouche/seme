'use strict';

// Loaded in Stremio's existing Node process; no listener, daemon or child server.
// A broken/missing Sème installation must never prevent Stremio from starting.
try {
  const key = Symbol.for('seme.stremio.integration');
  if (!global[key]) global[key] = require('./lib/runtime.cjs').start();
} catch (_) {
  console.error('[Sème] Integration unavailable; Stremio continues normally.');
}
