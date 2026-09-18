/**
 * LG webOS SSAP emulator - ws://<pc>:3000 (main) + ws://<pc>:3001 (pointer input)
 *
 * register handshake -> client-key issued (remembered; revoked keys rejected)
 * ssap:// requests   -> stateful volume/mute/channel/media/app effects
 * pointer socket     -> {"type":"button","name":…} frames for D-pad keys
 */
'use strict';

const http = require('http');
const { attach } = require('../lib/minws');
const { state, logEvent, markCoverage, applyKeyEffect, newToken } = require('../lib/state');
const live = require('../lib/live');

const SSAP_EFFECTS = {
  'ssap://audio/volumeUp': { type: 'volume', delta: +1 },
  'ssap://audio/volumeDown': { type: 'volume', delta: -1 },
  'ssap://tv/channelUp': { type: 'channel', delta: 1 },
  'ssap://tv/channelDown': { type: 'channel', delta: -1 },
  'ssap://media.controls/play': { type: 'app', app: '▶ playing' },
  'ssap://media.controls/pause': { type: 'app', app: '⏸ paused' },
};

const APP_NAMES = {
  netflix: 'Netflix',
  'youtube.leanback.v4': 'YouTube',
  hulu: 'Hulu',
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.disney.disneyplus-prod': 'Disney+',
  'com.webos.app.browser': 'Browser',
  'com.webos.app.miracast': 'Screen Share',
  'com.webos.app.search': 'Search',
};

const POINTER_BUTTONS = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME',
  'RED', 'GREEN', 'BLUE', 'YELLOW',
  'VOL_UP', 'VOL_DOWN', 'MUTE', 'CH_UP', 'CH_DOWN', 'POWER',
]);

const BUTTON_EFFECTS = {
  VOL_UP: { type: 'volume', delta: +1 },
  VOL_DOWN: { type: 'volume', delta: -1 },
  MUTE: { type: 'mute' },
  CH_UP: { type: 'channel', delta: 1 },
  CH_DOWN: { type: 'channel', delta: -1 },
  HOME: { type: 'home' },
  POWER: { type: 'power' },
};

function start(mainPort = 3000, pointerPort = 3001, host = '0.0.0.0') {
  // ---- main SSAP socket -----------------------------------------------------
  const main = http.createServer((req, res) => {
    const CORS = { 'Access-Control-Allow-Origin': '*' };
    // Real webOS answers plain HTTP on the SSAP port with an error doc quickly.
    if (state.power === 'off' || state.faults.lg === 'offline') { req.socket.destroy(); return; }
    res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SSAP is WebSocket only' }));
  });

  attach(main, '/', (conn, req) => {
    if (state.power === 'off' || state.faults.lg === 'offline') { conn.close(1011); return; }
    live.register('lg', conn);

    conn.handleFrame = (raw) => {
      if (state.faults.lg === 'error') return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'register') {
        const presented = msg.payload && msg.payload['client-key'];
        const keys = state.pairings.lgClientKeys;
        let clientKey;
        if (presented && keys[presented]) {
          clientKey = presented;
          keys[clientKey].lastUsed = Date.now();
          logEvent('lg', 'returning client re-registered (saved key accepted)');
        } else if (presented && !keys[presented]) {
          conn.send(JSON.stringify({ type: 'error', id: msg.id, error: 'pairing denied - key revoked' }));
          logEvent('lg', 'rejected revoked client-key');
          setTimeout(() => conn.close(1008), 150);
          return;
        } else {
          clientKey = newToken(16);
          keys[clientKey] = { issuedAt: Date.now() };
          logEvent('lg', 'new client-key issued (TV would show an approval popup)');
        }
        conn.send(JSON.stringify({
          type: 'registered', id: String(msg.id ?? 'register_0'),
          payload: { 'client-key': clientKey, pairingType: 'PROMPT' },
        }));
        return;
      }

      if (msg.type === 'request') {
        const uri = msg.uri || '';
        const id = String(msg.id ?? '');

        const reply = (payload) => conn.send(JSON.stringify({ type: 'response', id, payload }));
        markCoverage('lg', uri);

        if (uri === 'ssap://com.webos.remote.input/getPointerInputSocket') {
          logEvent('lg', 'pointer input socket requested');
          reply({ socketPath: `ws://${req.headers.host ? req.headers.host.split(':')[0] : 'localhost'}:${pointerPort}/pointer` });
          return;
        }
        if (uri === 'ssap://audio/getVolume') {
          reply({ volume: state.volume, muted: state.muted, scenario: 'main' });
          return;
        }
        if (uri === 'ssap://audio/getMute') {
          reply({ muteStatus: state.muted, scenario: 'main' });
          return;
        }
        if (uri === 'ssap://audio/setMute') {
          state.muted = !!(msg.payload && msg.payload.mute);
          logEvent('lg', `setMute -> ${state.muted}`);
          reply({ muteStatus: state.muted });
          return;
        }
        if (uri === 'ssap://system.launcher/launch') {
          const appId = (msg.payload && msg.payload.id) || '?';
          const target = msg.payload && msg.payload.params && msg.payload.params.target;
          const name = APP_NAMES[appId] || appId;
          state.app = target ? `${name}: ${target}` : name;
          logEvent('lg', `launch ${appId}${target ? ` target=${target}` : ''}`);
          reply({ returnValue: true, appId, sessionId: 'test' });
          return;
        }
        if (uri.startsWith('ssap://com.webos.service.ime/')) {
          const op = uri.split('/').pop();
          if (op === 'insertText' && msg.payload) {
            state.app = `typing: ${(state.app || '').replace(/^typing: ?/, '')}${msg.payload.text || ''}`;
            logEvent('lg', `ime insertText "${msg.payload.text}"`);
            markCoverage('lg', 'ime/insertText');
          } else {
            logEvent('lg', `ime ${op}`);
            markCoverage('lg', `ime/${op}`);
          }
          reply({ returnValue: true });
          return;
        }
        if (uri === 'ssap://system/turnOff') {
          logEvent('lg', 'turnOff (network standby)');
          state.power = 'standby';
          reply({ returnValue: true });
          return;
        }

        const effect = SSAP_EFFECTS[uri];
        if (effect) applyKeyEffect('lg', effect);
        logEvent('lg', `ssap ${uri}`);
        reply({ returnValue: true });
      }
    };
  });

  // ---- pointer input socket -------------------------------------------------
  const pointer = http.createServer((req, res) => {
    if (state.power === 'off' || state.faults.lg === 'offline') { req.socket.destroy(); return; }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'ws only' }));
  });

  attach(pointer, '/pointer', (conn) => {
    live.register('lgPointer', conn);
    conn.send(JSON.stringify({ type: 'pointerInputSocket', socketPath: '/pointer' }));
    conn.handleFrame = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'button' && POINTER_BUTTONS.has(msg.name)) {
        logEvent('lg', `button ${msg.name}`);
        markCoverage('lg', `button:${msg.name}`);
        const effect = BUTTON_EFFECTS[msg.name];
        if (effect) applyKeyEffect('lg', effect);
      }
    };
  });

  main.listen(mainPort, host, () => logEvent('system', `LG SSAP (WS) listening on ${host}:${mainPort}`));
  pointer.listen(pointerPort, host, () => logEvent('system', `LG pointer socket listening on ${host}:${pointerPort}`));
  return { main, pointer };
}

module.exports = { start };
