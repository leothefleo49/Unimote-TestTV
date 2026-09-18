/**
 * Roku ECP emulator - http://<pc>:8060
 *
 * Implements the real External Control Protocol surface Unimote uses:
 *   GET  /query/device-info       (XML device identity)
 *   GET  /query/apps              (channel list)
 *   POST /keypress/<Key>          (validates against the real ECP key names)
 *   POST /launch/<channelId>      (app launches incl. contentId deep links)
 *   POST /search/browse?keyword=  (voice search)
 */
'use strict';

const http = require('http');
const { state, logEvent, markCoverage, applyKeyEffect } = require('../lib/state');

// The real ECP key names (subset Unimote can send).
const VALID_KEYS = new Set([
  'Home', 'Rev', 'Fwd', 'Play', 'Select', 'Left', 'Right', 'Down', 'Up',
  'Back', 'InstantReplay', 'Info', 'Backspace', 'Search', 'Enter',
  'VolumeDown', 'VolumeMute', 'VolumeUp', 'PowerOff', 'ChannelUp', 'ChannelDown',
  'InputTuner', 'InputHDMI1', 'Power', 'PowerOn',
]);

const CHANNELS = {
  12: 'Netflix', 837: 'YouTube', 13: 'Prime Video', 2285: 'Hulu', 2915: 'Disney+',
};

// Key -> shared TV effect
const KEY_EFFECTS = {
  VolumeUp: { type: 'volume', delta: +2 },
  VolumeDown: { type: 'volume', delta: -2 },
  VolumeMute: { type: 'mute' },
  ChannelUp: { type: 'channel', delta: 1 },
  ChannelDown: { type: 'channel', delta: -1 },
  Home: { type: 'home' },
};

function start(port = 8060, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, AUTH',
    };
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const reply = (status, body, type) => {
      res.writeHead(status, { ...CORS, 'Content-Type': type || 'text/html' });
      res.end(body);
    };
    const json = (status, obj) => reply(status, JSON.stringify(obj), 'application/json');

    if (state.power === 'off') { req.socket.destroy(); return; }
    if (state.faults.roku === 'offline') { req.socket.destroy(); return; }
    if (state.faults.roku === 'error') { json(500, { error: 'simulated fault' }); return; }

    const respond = () => {
      if (url.pathname === '/query/device-info') {
        reply(200, `<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
  <serial-number>TESTTVROKU001</serial-number>
  <vendor-name>Roku</vendor-name>
  <model-name>TestTV Roku 5000X</model-name>
  <friendly-device-name>PC TestTV (Roku)</friendly-device-name>
  <power-mode>Ready</power-mode>
  <supports-remote-control>1</supports-remote-control>
</device-info>`, 'text/xml');
        markCoverage('roku', 'device-info');
        return;
      }
      if (url.pathname === '/query/apps') {
        json(200, {
          apps: Object.entries(CHANNELS).map(([id, name]) => ({ id: Number(id), name })),
        });
        return;
      }
      if (url.pathname.startsWith('/keypress/')) {
        const key = decodeURIComponent(url.pathname.slice('/keypress/'.length));
        if (!VALID_KEYS.has(key) && !key.startsWith('Lit_')) {
          // Real Roku behavior for an unknown key.
          reply(404, '', 'text/html');
          return;
        }
        logEvent('roku', `keypress ${key}`);
        const base = key.startsWith('Lit_') ? key : key.replace(/Lit_.*/, 'Lit_text');
        markCoverage('roku', key.startsWith('Lit_') ? key : key);
        const effect = KEY_EFFECTS[key];
        if (effect) applyKeyEffect('roku', effect);
        if (key === 'PowerOff' || key === 'Power') applyKeyEffect('roku', { type: 'power' });
        reply(200, '', 'text/html');
        return;
      }
      if (url.pathname.startsWith('/launch/')) {
        const channelId = url.pathname.slice('/launch/'.length).split('?')[0];
        const contentId = url.searchParams.get('contentId');
        const appName = CHANNELS[channelId] || `channel ${channelId}`;
        state.app = contentId ? `${appName} (content ${contentId})` : appName;
        logEvent('roku', `launch ${appName}${contentId ? ` contentId=${contentId}` : ''}`);
        markCoverage('roku', `launch:${channelId}`);
        reply(200, '', 'text/html');
        return;
      }
      if (url.pathname.startsWith('/search/browse')) {
        const kw = url.searchParams.get('keyword');
        logEvent('roku', `search "${kw}"`);
        markCoverage('roku', 'search:browse');
        state.app = `Search: ${kw}`;
        json(200, { result: 'ok' });
        return;
      }
      reply(404, 'not found');
    };

    if (state.faults.roku === 'slow') {
      // Wait for the request body (if any), then delay 2.5s.
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => setTimeout(respond, 2500));
    } else {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', respond);
    }
  });

  server.listen(port, host, () => logEvent('system', `Roku ECP listening on ${host}:${port}`));
  return server;
}

module.exports = { start };
