/**
 * Samsung Tizen emulator - http://<pc>:8001
 *
 * HTTP  GET  /api/v2/            -> device identity JSON (detection)
 * WS    /api/v2/channels/samsung.remote.control?name=<b64>[&token=…]
 *        on open: sends ms.channel.connect with a fresh token
 *        accepts ms.remote.control Click keys + RunApp launches
 *        bad/revoked token -> ms.channel.unauthorized (like a real TV)
 */
'use strict';

const http = require('http');
const { attach } = require('../lib/minws');
const { state, logEvent, markCoverage, applyKeyEffect, newToken } = require('../lib/state');
const live = require('../lib/live');

const VALID_KEYS = new Set([
  'KEY_POWER', 'KEY_POWEROFF', 'KEY_HOME', 'KEY_RETURN', 'KEY_UP', 'KEY_DOWN',
  'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE',
  'KEY_CHUP', 'KEY_CHDOWN', 'KEY_MENU', 'KEY_INFO', 'KEY_PLAY', 'KEY_PAUSE',
  'KEY_STOP', 'KEY_SOURCE', 'KEY_REWIND', 'KEY_FF', 'KEY_NETFLIX', 'KEY_YOUTUBE',
  'KEY_0', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5', 'KEY_6', 'KEY_7', 'KEY_8', 'KEY_9',
  'KEY_SEARCH',
]);

const KEY_EFFECTS = {
  KEY_VOLUP: { type: 'volume', delta: +2 },
  KEY_VOLDOWN: { type: 'volume', delta: -2 },
  KEY_MUTE: { type: 'mute' },
  KEY_CHUP: { type: 'channel', delta: 1 },
  KEY_CHDOWN: { type: 'channel', delta: -1 },
  KEY_HOME: { type: 'home' },
  KEY_NETFLIX: { type: 'app', app: 'Netflix' },
  KEY_YOUTUBE: { type: 'app', app: 'YouTube' },
};

function start(port = 8001, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, AUTH',
    };
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (state.power === 'off' || state.faults.samsung === 'offline') { req.socket.destroy(); return; }
    const json = (status, obj) => {
      res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (state.faults.samsung === 'error') { json(500, { error: 'simulated fault' }); return; }

    if (url.pathname === '/api/v2/' || url.pathname === '/api/v2') {
      json(200, {
        device: {
          Type: 'Device',
          DUID: 'TESTTVSAMSUNG1',
          ModelName: 'PC TestTV QN55Tizen',
          DeviceName: 'PC TestTV (Samsung)',
          WFDevice: true,
          TokenAuthSupport: true,
        },
        id: 'TESTTVSAMSUNG1',
      });
      return;
    }
    json(404, { error: 'not found' });
  });

  attach(server, '/api/v2/channels/samsung.remote.control', (conn, req) => {
    if (state.power === 'off' || state.faults.samsung === 'offline') { conn.close(1011); return; }
    live.register('samsung', conn);
    const url = new URL(req.url, 'http://localhost');
    const nameParam = url.searchParams.get('name') || '';
    let appName = 'remote';
    try { appName = Buffer.from(nameParam, 'base64').toString('utf8') || 'remote'; } catch { /* keep default */ }
    const presentedToken = url.searchParams.get('token');

    // Token rules, like a real TV:
    //   - first connection (no token) -> issue one, remember it
    //   - valid remembered token     -> silent connect
    //   - revoked / unknown token    -> ms.channel.unauthorized (Unimote re-pairs)
    const pairings = state.pairings.samsung;
    let token;
    if (!presentedToken) {
      token = newToken(8);
      pairings[token] = { name: appName, issuedAt: Date.now() };
      logEvent('samsung', `new pairing granted to "${appName}" (token issued)`);
    } else if (pairings[presentedToken]) {
      token = presentedToken;
      pairings[token].lastUsed = Date.now();
    } else {
      conn.send(JSON.stringify({ event: 'ms.channel.unauthorized', data: { id: '' } }));
      logEvent('samsung', `rejected unknown/revoked token from "${appName}"`);
      setTimeout(() => conn.close(1008), 150);
      return;
    }

    conn.send(JSON.stringify({
      event: 'ms.channel.connect',
      data: { id: '', token, name: appName },
    }));

    conn.handleFrame = (raw) => {
      if (state.faults.samsung === 'error') return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.method !== 'ms.remote.control' || !msg.params) return;
      const { Cmd } = msg.params;

      if (Cmd === 'Click') {
        const key = msg.params.DataOfCmd;
        if (!VALID_KEYS.has(key)) {
          logEvent('samsung', `ignored unknown key ${key}`);
          return;
        }
        logEvent('samsung', `key ${key}`);
        markCoverage('samsung', key);
        const effect = KEY_EFFECTS[key];
        if (effect) applyKeyEffect('samsung', effect);
        if (key === 'KEY_POWER' || key === 'KEY_POWEROFF') applyKeyEffect('samsung', { type: 'power' });
        if (key === 'KEY_SOURCE') state.input = 'HDMI 2';
        return;
      }
      if (Cmd === 'RunApp') {
        const appId = msg.params.AppId || '?';
        const meta = msg.params.MetaTag || '';
        const app = appId.includes('browser') ? `Browser${meta ? `: ${meta}` : ''}` : `app ${appId}`;
        state.app = app;
        logEvent('samsung', `RunApp ${appId}${meta ? ` meta=${meta}` : ''}`);
        markCoverage('samsung', `RunApp:${appId}`);
      }
    };
    conn.onclose = () => { /* next press reconnects */ };
  });

  server.listen(port, host, () => logEvent('system', `Samsung Tizen (HTTP+WS) listening on ${host}:${port}`));
  return server;
}

module.exports = { start };
