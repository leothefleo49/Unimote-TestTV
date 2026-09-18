/**
 * Sony Bravia emulator - http://<pc>/sony/*
 *
 *   POST /sony/system  -> JSON-RPC getSystemInformation (detection)
 *   POST /sony/IRCC    -> SOAP X_SendIRCC key codes
 */
'use strict';

const http = require('http');
const { state, logEvent, markCoverage, applyKeyEffect } = require('../lib/state');

// Unimote's IRCC base64 codes -> readable names (matches SONY_IRCC_MAP).
const IRCC_NAMES = {
  'AAAAAQAAAAEAAAAVAw==': 'power',
  'AAAAAQAAAAEAAAAvAw==': 'poweroff',
  'AAAAAQAAAAEAAABgAw==': 'home',
  'AAAAAgAAAJcAAAAjAw==': 'back',
  'AAAAAQAAAAEAAAB0Aw==': 'up',
  'AAAAAQAAAAEAAAB1Aw==': 'down',
  'AAAAAQAAAAEAAAA0Aw==': 'left',
  'AAAAAQAAAAEAAAAzAw==': 'right',
  'AAAAAQAAAAEAAABlAw==': 'ok',
  'AAAAAQAAAAEAAAASAw==': 'volume_up',
  'AAAAAQAAAAEAAAATAw==': 'volume_down',
  'AAAAAQAAAAEAAAAUAw==': 'mute',
  'AAAAAQAAAAEAAAAQAw==': 'channel_up',
  'AAAAAQAAAAEAAAARAw==': 'channel_down',
  'AAAAAgAAAJcAAAAaAw==': 'play',
  'AAAAAgAAAJcAAAAZAw==': 'pause',
  'AAAAAQAAAAEAAAAlAw==': 'input',
  'AAAAAQAAAAEAAAAkAw==': 'info',
};

const EFFECTS = {
  volume_up: { type: 'volume', delta: +2 },
  volume_down: { type: 'volume', delta: -2 },
  mute: { type: 'mute' },
  channel_up: { type: 'channel', delta: 1 },
  channel_down: { type: 'channel', delta: -1 },
  home: { type: 'home' },
  input: { type: 'app', app: 'Input menu' },
};

function start(port = 80, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, SOAPACTION',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (state.power === 'off' || state.faults.sony === 'offline') { req.socket.destroy(); return; }
    const respond = () => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const xml = (status, body) => {
        res.writeHead(status, { ...CORS, 'Content-Type': 'text/xml; charset=UTF-8' });
        res.end(body);
      };
      const json = (status, obj) => {
        res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (state.faults.sony === 'error') { json(500, { error: 'simulated fault' }); return; }

      if (url.pathname === '/sony/system') {
        let method = '';
        try { method = JSON.parse(body || '{}').method || ''; } catch { /* bare GET probe */ }
        logEvent('sony', `system ${method || 'probe'}`);
        markCoverage('sony', 'system:getSystemInformation');
        if (method === 'getSystemInformation') {
          json(200, {
            id: 1, result: [{ product: 'TV', model: 'PC-TestTV-BRAVIA', name: 'PC TestTV (Sony)', language: 'eng' }],
          });
        } else {
          // Sony's JSON-RPC error shape still proves the device type.
          json(200, { id: 1, error: [7, ' Illegal State', ''] });
        }
        return;
      }

      if (url.pathname === '/sony/IRCC') {
        const match = (body || '').match(/<IRCCCode>([^<]+)<\/IRCCCode>/);
        const name = match ? IRCC_NAMES[match[1]] : null;
        if (!name) {
          xml(500, '<s:Envelope/>');
          return;
        }
        logEvent('sony', `IRCC ${name}`);
        markCoverage('sony', `IRCC:${name}`);
        const effect = EFFECTS[name];
        if (effect) applyKeyEffect('sony', effect);
        if (name === 'power' || name === 'poweroff') applyKeyEffect('sony', { type: 'power' });
        xml(200, '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:X_SendIRCCResponse xmlns:u="urn:schemas-sony-com:service:IRCC:1"></u:X_SendIRCCResponse></s:Body></s:Envelope>');
        return;
      }

      json(404, { error: 'not found' });
    };

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (state.faults.sony === 'slow') setTimeout(respond, 2500); else respond();
    });
  });

  server.listen(port, host, () => logEvent('system', `Sony Bravia listening on ${host}:${port}`));
  return server;
}

module.exports = { start };
