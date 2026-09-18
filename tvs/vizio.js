/**
 * Vizio SmartCast emulator - http://<pc>:7345
 *
 * Real behavior Unimote must handle:
 *   - every command without a valid AUTH header -> 401 Unauthorized
 *   - PUT /pairing/start  -> PAIRING_REQ_TOKEN (TV "displays" a PIN - shown in the dashboard)
 *   - PUT /pairing/pair   -> correct PIN returns an AUTH_TOKEN
 *   - PUT /key_command/   -> authenticated key codes
 *   - GET /state/device/power_mode -> authenticated state read
 */
'use strict';

const http = require('http');
const { state, logEvent, markCoverage, applyKeyEffect, newToken } = require('../lib/state');

const CODE_EFFECTS = {
  '5:1': { type: 'volume', delta: +2 },
  '5:0': { type: 'volume', delta: -2 },
  '5:3': { type: 'mute' },
  '8:1': { type: 'channel', delta: 1 },
  '8:0': { type: 'channel', delta: -1 },
  '4:3': { type: 'home' },
};

function start(port = 7345, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, AUTH',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (state.power === 'off' || state.faults.vizio === 'offline') { req.socket.destroy(); return; }
    const json = (status, obj) => {
      res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (state.faults.vizio === 'error') { json(500, { STATUS: { RESULT: 'ERROR', DETAIL: 'simulated fault' } }); return; }
    const slow = state.faults.vizio === 'slow';

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (slow) setTimeout(() => handle(), 2500); else handle();
    });

    function handle() {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const auth = req.headers['auth'];
      const v = state.pairings.vizio;

      if (url.pathname === '/pairing/start' && req.method === 'PUT') {
        v.pairReqToken = Math.floor(Math.random() * 90000) + 10000;
        v.pin = v.pinMode === 'fixed' ? '1234' : String(Math.floor(Math.random() * 9000) + 1000);
        logEvent('vizio', `pairing started - PIN "${v.pin}" is displayed on the "TV" (dashboard)`);
        markCoverage('vizio', 'pairing:start');
        json(200, { STATUS: { RESULT: 'SUCCESS', PAIRING_REQ_TOKEN: v.pairReqToken }, ITEMS: [] });
        return;
      }

      if (url.pathname === '/pairing/pair' && req.method === 'PUT') {
        markCoverage('vizio', 'pairing:pair');
        try {
          const j = JSON.parse(body);
          if (j.PAIRING_REQ_TOKEN !== v.pairReqToken || String(j.RESPONSE_VALUE) !== String(v.pin)) {
            logEvent('vizio', 'pairing rejected (wrong PIN or stale request token)');
            json(200, { STATUS: { RESULT: 'FAILED', DETAIL: 'Invalid PIN' }, ITEMS: [] });
            return;
          }
          v.authToken = newToken(12);
          logEvent('vizio', `paired! AUTH token issued to "${j.DEVICE_NAME}"`);
          json(200, { STATUS: { RESULT: 'SUCCESS', PAIRING_REQ_TOKEN: v.pairReqToken }, ITEMS: [{ AUTH_TOKEN: v.authToken }] });
        } catch {
          json(400, { STATUS: { RESULT: 'ERROR' }, ITEMS: [] });
        }
        return;
      }

      const authorized = auth && auth === v.authToken;

      if (url.pathname === '/state/device/power_mode') {
        if (!authorized) { json(401, { STATUS: { RESULT: 'FAILURE', DETAIL: 'Unauthorized' }, ITEMS: [] }); return; }
        const value = state.power === 'on' ? 'ON' : 'OFF';
        json(200, {
          STATUS: { RESULT: 'SUCCESS', DETAIL: 'success' },
          ITEMS: [{ HASHVAL: 1, NAME: 'power_mode', VALUE: value, CNAME: 'power_mode', TYPE: 'ENUM' }],
          URI: '/state/device/power_mode',
        });
        return;
      }

      if (url.pathname === '/key_command/') {
        if (!authorized) {
          json(401, { STATUS: { RESULT: 'FAILURE', DETAIL: 'Unauthorized' }, ITEMS: [] });
          return;
        }
        try {
          const j = JSON.parse(body);
          const k = (j.KEYLIST || [])[0] || {};
          const id = `key:${k.CODESET}:${k.CODE}`;
          logEvent('vizio', `key_command codeset=${k.CODESET} code=${k.CODE}`);
          markCoverage('vizio', id);
          const effect = CODE_EFFECTS[`${k.CODESET}:${k.CODE}`];
          if (effect) applyKeyEffect('vizio', effect);
          if (k.CODESET === 11) applyKeyEffect('vizio', { type: 'power' });
          if (k.CODESET === 7) state.input = 'Comp 1';
          json(200, { STATUS: { RESULT: 'SUCCESS', DETAIL: 'success' }, ITEMS: [] });
        } catch {
          json(400, { STATUS: { RESULT: 'ERROR' }, ITEMS: [] });
        }
        return;
      }

      json(404, { STATUS: { RESULT: 'ERROR', DETAIL: 'Not Found' }, ITEMS: [] });
    }
  });

  server.listen(port, host, () => logEvent('system', `Vizio SmartCast listening on ${host}:${port}`));
  return server;
}

module.exports = { start };
