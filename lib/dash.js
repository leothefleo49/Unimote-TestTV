/**
 * dash.js - the TestTV dashboard: a live "TV screen" + protocol log +
 * per-brand button-coverage checklists + pairing management + fault injection.
 *
 * Served at http://localhost:8520 (or DASH_PORT). Everything updates live over
 * Server-Sent Events - press buttons in Unimote and watch this screen react.
 */
'use strict';

const http = require('http');
const os = require('os');
const { state, bus, logEvent, coverageSnapshot, resetCoverage, resetPairings, resetState } = require('./state');
const { TV_MAC } = require('../tvs/wol');
const live = require('./live');

const PORT = Number(process.env.DASH_PORT || 8520);

// The dashboard UI can be opened from another origin (e.g. the Vercel-hosted
// copy at https://unimote-test-tv.vercel.app). Cross-origin reads of a local
// address also trip Chrome's Private Network Access rules, which need an
// explicit opt-in header - without these, fetch() from the hosted page fails
// even though the SSE stream (which sets its own CORS header) connects.
function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    ...(extra || {}),
  };
}

function lanIps() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const fs = require('fs');
const path = require('path');

// The dashboard UI lives in web/index.html — the SAME file the Vercel-hosted copy
// serves, so the local dashboard and the hosted one can never drift apart.
const WEB_INDEX = path.join(__dirname, '..', 'web', 'index.html');
let PAGE_CACHE = null;
function dashboardHtml() {
  if (PAGE_CACHE === null) PAGE_CACHE = fs.readFileSync(WEB_INDEX, 'utf8');
  return PAGE_CACHE;
}

function start() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // CORS preflight (also used by Chrome's Private Network Access checks).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        res.writeHead(200, corsHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }));
        res.end(dashboardHtml());
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Could not read web/index.html: ' + e.message);
      }
      return;
    }

    if (url.pathname === '/snapshot') {
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({
        state,
        coverage: coverageSnapshot(),
        events: state.events,
        live: live.counts(),
      }));
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, corsHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }));
      res.write('retry: 2000\n\n');
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const onEvent = (event) => send({ event });
      const onState = () => send({ state, live: live.counts() });
      const onCoverage = () => send({ coverage: coverageSnapshot() });
      bus.on('event', onEvent);
      bus.on('state', onState);
      bus.on('coverage', onCoverage);
      const pushState = () => send({ state, live: live.counts() });
      bus.on('state', pushState);
      send({ state, live: live.counts() });
      send({ coverage: coverageSnapshot() });
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        bus.off('event', onEvent);
        bus.off('state', onState);
        bus.off('state', pushState);
        bus.off('coverage', onCoverage);
      });
      return;
    }

    if (url.pathname === '/api' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let op = {};
        try { op = JSON.parse(body || '{}'); } catch { /* ignore */ }
        switch (op.op) {
          case 'fault':
            if (state.faults[op.tv] !== undefined) {
              state.faults[op.tv] = op.mode;
              logEvent('system', `fault set: ${op.tv} -> ${op.mode}`);
            }
            break;
          case 'power':
            state.power = state.power === 'off' ? 'on' : 'off';
            logEvent('system', state.power === 'off' ? 'TV powered OFF from dashboard' : 'TV powered ON from dashboard');
            break;
          case 'pin-mode':
            state.pairings.vizio.pinMode = state.pairings.vizio.pinMode === 'fixed' ? 'random' : 'fixed';
            logEvent('system', `Vizio PIN mode: ${state.pairings.vizio.pinMode}`);
            break;
          case 'reset-coverage': resetCoverage(); break;
          case 'reset-pairings': {
            // Like "forget device" on a real TV: revoke credentials AND drop the
            // established channels, forcing a fresh handshake + re-pair on the app side.
            const dropped = live.closeAllBrands();
            resetPairings();
            if (dropped) logEvent('system', `dropped ${dropped} open socket(s) - next press re-pairs`);
            break;
          }
          case 'reset-all': resetState(); break;
        }
        bus.emit('state');
        res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end('{"ok":true}');
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanIps();
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────┐');
    console.log('  │  Unimote TestTV dashboard                            │');
    console.log(`  │  →  http://localhost:${PORT}  (or http://${ips[0] || 'your-pc-ip'}:${PORT})  │`);
    console.log('  └──────────────────────────────────────────────────────┘');
    ips.forEach((ip) => console.log(`  Point Unimote (manual IP) at:  ${ip}`));
    console.log('');
  });
  return server;
}

module.exports = { start };
