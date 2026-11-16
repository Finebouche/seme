'use strict';

// Runs inside Stremio's existing Node process; no helper service is started.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configPath, defaultConfig, loadConfig, saveConfig } = require('./config.cjs');

const DEFAULT_PORT = 17881;
const MANIFEST_ID = 'org.finebouche.seme';
const VERSION = '0.4.3';
const MAX_BODY = 32768;
const logo = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
const manifest = {
  id: MANIFEST_ID, version: VERSION, name: 'Sème',
  description: 'Intégration locale : conserve les vidéos du cache Stremio dans votre client torrent. Désinstaller cet addon retire seulement sa fiche ; utilisez Sème Setup pour retirer l’intégration.',
  resources: ['meta'], types: ['other'], idPrefixes: ['seme:'], catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false },
};

function escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

const errorLabels = {
  CACHE_UNAVAILABLE: 'Cache momentanément indisponible',
  INVALID_STATE: 'État local à vérifier dans Sème Setup',
  TRANSFER_FAILED: 'Transfert à vérifier dans Sème Setup',
  ECONNREFUSED: 'Client torrent injoignable',
  ETIMEDOUT: 'Le client torrent ne répond pas',
  ENOSPC: 'Espace disque insuffisant',
  AUTH_FAILED: 'Authentification du client à vérifier',
  UNSUPPORTED_STORAGE: 'Dossiers du client à vérifier',
  OWNERSHIP_CHANGED: 'Transfert modifié dans le client',
};

async function statusText(file) {
  let handle;
  try {
    handle = await fs.promises.open(path.join(path.dirname(file), 'status.json'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid status');
    const status = JSON.parse(await handle.readFile('utf8'));
    const date = typeof status.lastScan === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(status.lastScan) ? new Date(status.lastScan) : null;
    const scan = date && Number.isFinite(date.getTime()) ? `Dernière analyse : ${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}.` : 'Aucune analyse récente.';
    const count = Number.isSafeInteger(status.imported) && status.imported >= 0 ? status.imported : 0;
    const errors = Array.isArray(status.errors) ? status.errors : [];
    const code = errors[0] && errors[0].code;
    const problem = errors.length ? ` À vérifier : ${Object.prototype.hasOwnProperty.call(errorLabels, code) ? errorLabels[code] : 'ouvrez les diagnostics dans Sème Setup'}.` : '';
    return `${scan} ${count} transfert(s) lors de cette analyse.${problem}`;
  } catch { return 'Aucune analyse disponible. Ouvrez Sème Setup pour les diagnostics.'; }
  finally { if (handle) await handle.close(); }
}

function page(config, token, status, notice = '') {
  const input = (name, label, value, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sème · Configuration</title><style>
  :root{color-scheme:light;font:15px/1.5 system-ui,sans-serif;color:#243b30;background:#f4f1e9}*{box-sizing:border-box}body{margin:0;padding:36px 18px}main{max-width:660px;margin:auto;background:#fffdf7;border:1px solid #dcded0;border-radius:24px;padding:30px;box-shadow:0 12px 45px #243b300a}header{display:flex;align-items:center;gap:15px}svg{width:54px;height:54px}h1{font-size:32px;line-height:1;margin:0}header p{margin:8px 0 0;color:#627266}h2{font-size:17px;margin:25px 0 12px}.status,.notice{padding:13px 15px;border-radius:12px;background:#edf1e6;font-size:13px}.notice{background:#e0eedc}form{margin-top:24px}label{display:block;font-size:13px;font-weight:600;margin:13px 0}input,select{display:block;width:100%;margin-top:5px;padding:10px 11px;border:1px solid #cbd3c6;border-radius:8px;background:white;font:inherit;color:#243b30}input:focus,select:focus{outline:2px solid #658957;outline-offset:1px}.check{display:flex;gap:9px;align-items:center}.check input{width:auto;margin:0}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.hint,footer{font-size:12px;color:#627266}button{padding:12px 19px;background:#345e3a;color:white;border:0;border-radius:10px;font:600 14px system-ui;cursor:pointer;margin:15px 0}footer{border-top:1px solid #e0e4d8;margin-top:16px;padding-top:15px}@media(max-width:480px){main{padding:22px}.row{display:block}body{padding:15px}}
  </style></head><body><main><header><svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true"><defs><linearGradient id="seed" x1="14" y1="53" x2="49" y2="10" gradientUnits="userSpaceOnUse"><stop stop-color="#27956C"/><stop offset="1" stop-color="#B6E891"/></linearGradient></defs><path d="M50 9C33 8 15 17 11 33C7 47 17 57 30 55C46 53 56 34 50 9Z" fill="url(#seed)"/><path d="M49 12C47 28 36 44 22 50" stroke="#123D2E" stroke-width="3.5" stroke-linecap="round"/><path d="M19 30C22 24 28 20 34 18" stroke="#DFF6CB" stroke-width="3" stroke-linecap="round" opacity=".65"/></svg><div><h1>Sème</h1><p>Le partage commence ici.</p></div></header>
  <p>Conservez les vidéos terminées du cache Stremio dans votre client torrent local, qui prend ensuite en charge leur partage.</p><p class="status">${escape(status)}</p>${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ''}
  <form method="post" action="/configure"><input type="hidden" name="csrf" value="${token}"><label class="check"><input type="checkbox" name="enabled" value="1"${config.enabled ? ' checked' : ''}>Activer la conservation automatique</label>
  <h2>Client torrent</h2><label>Application<select name="clientType">${[['transmission', 'Transmission'], ['qbittorrent', 'qBittorrent'], ['deluge', 'Deluge']].map(([value, label]) => `<option value="${value}"${config.client.type === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
  ${input('clientUrl', 'Adresse locale du client', config.client.url, 'url', 'required')}
  <div class="row">${input('username', 'Nom d’utilisateur', config.client.username, 'text', 'autocomplete="username"')}${input('password', 'Nouveau mot de passe', '', 'password', 'autocomplete="new-password"')}</div><p class="hint">Laissez le mot de passe vide pour conserver celui déjà enregistré. Il n’est jamais affiché.</p><label class="check"><input type="checkbox" name="clearPassword" value="1">Effacer le mot de passe enregistré</label>
  <h2>Dossiers</h2>${input('cacheDir', 'Cache Stremio', config.cacheDir, 'text', 'required')}${input('destinationDir', 'Vidéos conservées', config.destinationDir, 'text', 'required')}<p class="hint">Indiquez des chemins absolus vers deux dossiers distincts. Le sélecteur de dossiers reste disponible dans Sème Setup.</p><button type="submit">Enregistrer les réglages</button></form>
  <footer>Les réglages sont relus automatiquement à la prochaine analyse. Après une mise à jour du module, redémarrez Stremio pour l’activer.<p>Dans Stremio, « Désinstaller » retire seulement cet addon visible. Pour retirer complètement l’intégration, fermez Stremio puis utilisez la désinstallation de Sème Setup.</p></footer></main></body></html>`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], exceeded = false;
    const length = request.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) { request.resume(); reject({ status: 413 }); return; }
    request.on('data', chunk => {
      if (exceeded) return;
      size += chunk.length;
      if (size > MAX_BODY) { exceeded = true; chunks = []; reject({ status: 413 }); }
      else chunks.push(chunk);
    });
    request.on('end', () => { if (!exceeded) resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); });
    request.on('error', () => reject({ status: 400 }));
  });
}

function launcherPage(nonce) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ouvrir Sème Setup</title><style>
  body{font:16px/1.6 system-ui,sans-serif;color:#243b30;background:#f4f1e9;padding:40px 20px}main{max-width:520px;margin:auto}a{color:#345e3a}.open{display:inline-block;padding:12px 20px;background:#345e3a;color:white;border-radius:10px;text-decoration:none}small{display:block;margin-top:24px}
  </style></head><body><main><h1>Configuration de Sème</h1><p>Les réglages s’ouvrent dans Sème Setup. Si votre navigateur le demande, autorisez l’ouverture de l’application.</p><p><a class="open" href="seme://configure">Ouvrir Sème Setup</a></p><p>Si rien ne se passe, ouvrez une fois la nouvelle application Sème Setup depuis le Finder pour l’enregistrer auprès de macOS, puis réessayez.</p><small><a href="/configure?web=1">Utiliser la configuration web</a> · Vous pouvez fermer cette page après l’ouverture de l’application.</small></main><script nonce="${nonce}">window.location.href = 'seme://configure';</script></body></html>`;
}

function start(options = {}) {
  const file = options.configFile || configPath();
  const token = crypto.randomBytes(32).toString('hex');
  let origin, stopping;
  const server = http.createServer((request, response) => {
    function send(status, body, type = 'text/plain; charset=utf-8', cors = false, scriptNonce = '') {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" + (scriptNonce ? `; script-src 'nonce-${scriptNonce}'` : ''),
        'X-Frame-Options': 'DENY', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) });
      response.end(body);
    }
    async function route() {
      if (request.headers.host !== origin.slice(7)) return send(403, 'Accès local refusé.');
      const pathname = request.url.split('?')[0];
      const publicRoute = pathname === '/manifest.json' || pathname === '/icon.png' || /^\/meta\/other\/seme(?::|%3[aA])[^/]*\.json$/.test(pathname);
      if (request.method === 'OPTIONS' && publicRoute) {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
          ...(request.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return response.end();
      }
      if (request.method === 'GET' && pathname === '/manifest.json') return send(200, JSON.stringify({ ...manifest, logo: `${origin}/icon.png` }), 'application/json; charset=utf-8', true);
      if (request.method === 'GET' && pathname === '/icon.png') return send(200, logo, 'image/png', true);
      if (request.method === 'GET' && /^\/meta\/other\/seme(?::|%3[aA])[^/]*\.json$/.test(pathname)) return send(200, '{"meta":null}', 'application/json; charset=utf-8', true);
      if (pathname !== '/configure' && pathname !== '/configure/') return send(404, 'Introuvable.');
      if (request.headers.origin && request.headers.origin !== origin) return send(403, 'Origine refusée.');
      if (request.method === 'GET') {
        const query = new URL(request.url, origin).searchParams;
        if (query.get('web') !== '1') {
          const nonce = crypto.randomBytes(24).toString('base64');
          return send(200, launcherPage(nonce), 'text/html; charset=utf-8', false, nonce);
        }
        let config, notice = query.get('saved') === '1' ? 'Réglages enregistrés. Ils seront utilisés à la prochaine analyse.' : '';
        try { config = await loadConfig(file); }
        catch (error) { config = defaultConfig(); notice = error.code === 'ENOENT' ? 'Enregistrez vos réglages pour commencer.' : 'Configuration illisible. Vérifiez-la dans Sème Setup.'; }
        return send(200, page(config, token, await statusText(file), notice), 'text/html; charset=utf-8');
      }
      if (request.method !== 'POST') return send(405, 'Méthode refusée.');
      if (request.headers.origin !== origin) return send(403, 'Origine refusée.');
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return send(415, 'Format de formulaire requis.');
      const fields = await readBody(request);
      if (fields.get('csrf') !== token) return send(403, 'Formulaire expiré. Rechargez la page.');
      // Reject duplicate fields rather than silently accepting ambiguous input.
      for (const key of fields.keys()) if (fields.getAll(key).length !== 1) return send(400, 'Formulaire invalide.');
      let config;
      try { config = await loadConfig(file); }
      catch (error) { if (error.code !== 'ENOENT') return send(400, 'Configuration illisible. Ouvrez Sème Setup.'); config = defaultConfig(); }
      const password = fields.get('password') || '';
      const next = { ...config, enabled: fields.get('enabled') === '1', cacheDir: fields.get('cacheDir'), destinationDir: fields.get('destinationDir'),
        client: { ...config.client, type: fields.get('clientType'), url: fields.get('clientUrl'), username: fields.get('username') || '',
          password: fields.get('clearPassword') === '1' ? '' : password || config.client.password } };
      try { await saveConfig(next, file); }
      catch { return send(400, 'Réglages invalides ou enregistrement impossible. Vérifiez les dossiers, le client et son adresse locale dans Sème Setup.'); }
      // Redirect avoids resubmitting credentials when the user refreshes.
      response.writeHead(303, { Location: '/configure?web=1&saved=1', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' }); response.end();
    }
    route().catch(error => send(error && error.status === 413 ? 413 : 400, error && error.status === 413 ? 'Formulaire trop volumineux.' : 'Requête impossible. Ouvrez Sème Setup.'));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port === undefined ? DEFAULT_PORT : options.port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      server.unref();
      resolve({ url: origin, port: server.address().port });
    });
  });
  return { ready, stop() {
    if (!stopping) stopping = ready.then(() => new Promise(resolve => server.close(() => resolve())), () => undefined);
    return stopping;
  } };
}

module.exports = { start, DEFAULT_PORT, MANIFEST_ID, VERSION };
