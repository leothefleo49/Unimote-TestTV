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

function lanIps() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unimote TestTV</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, Segoe UI, sans-serif; background: #0b1020; color: #e5e9f0; }
  header { padding: 14px 20px; background: #131a33; border-bottom: 1px solid #2a3560; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  header h1 { font-size: 18px; margin: 0; }
  header .ip { font-family: ui-monospace, Consolas, monospace; color: #7dd3fc; }
  main { display: grid; grid-template-columns: 340px 1fr; gap: 16px; padding: 16px 20px; max-width: 1400px; margin: 0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background: #121936; border: 1px solid #26305a; border-radius: 12px; padding: 14px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #93a4d0; margin: 0 0 10px; }
  .tv { background: #000; border-radius: 12px; border: 6px solid #2a3560; padding: 22px; min-height: 150px; text-align: center; }
  .tv .screen { font-size: 26px; font-weight: 700; }
  .tv .sub { color: #9aa7c7; margin-top: 6px; font-size: 13px; }
  .tv.off { color: #333; }
  .bar { height: 10px; background: #1c2547; border-radius: 6px; margin-top: 12px; overflow: hidden; }
  .bar > div { height: 100%; background: linear-gradient(90deg,#38bdf8,#818cf8); transition: width .15s; }
  .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed #222c52; font-size: 13px; }
  .row:last-child { border: 0; }
  button { background: #263469; color: #dbe4ff; border: 1px solid #3b4c8f; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
  button:hover { background: #32427f; }
  button.danger { background: #5c1f2e; border-color: #8f2d44; }
  .faults { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 6px; }
  .faults button { padding: 5px 4px; font-size: 12px; }
  .faults button.on { background: #38bdf8; color: #06263a; border-color: #7dd3fc; font-weight: 700; }
  pre#log { max-height: 260px; overflow: auto; font: 12px/1.5 ui-monospace, Consolas, monospace; background: #0a0f22; border-radius: 8px; padding: 10px; }
  pre#log .t { color: #64748b; }
  .brand h3 { display: flex; justify-content: space-between; font-size: 13px; margin: 14px 0 6px; color: #cbd5f5; }
  .pct { font-weight: 700; color: #7dd3fc; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 11px; font-family: ui-monospace, Consolas, monospace; padding: 2px 7px; border-radius: 20px; border: 1px solid #33406f; color: #6b7aa8; }
  .chip.done { background: #10321f; border-color: #2f7d4f; color: #6ee7a0; }
  .pin { font-family: ui-monospace, Consolas, monospace; font-size: 22px; letter-spacing: .35em; color: #fbbf24; }
  .hint { color: #8fa0cc; font-size: 12px; margin-top: 8px; }
  a { color: #7dd3fc; }
</style>
</head>
<body>
<header>
  <h1>📺 Unimote TestTV</h1>
  <span class="ip" id="ips"></span>
  <span style="flex:1"></span>
  <button onclick="api({op:'reset-coverage'})">Reset coverage</button>
  <button onclick="api({op:'reset-pairings'})">Revoke all pairings</button>
  <button class="danger" onclick="api({op:'reset-all'})">Reset everything</button>
</header>
<main>
  <div style="display:flex;flex-direction:column;gap:16px">
    <section>
      <h2>TV Screen</h2>
      <div class="tv" id="tv">
        <div class="screen" id="screen">—</div>
        <div class="sub" id="tvsub"></div>
        <div class="bar"><div id="volbar" style="width:0%"></div></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="pwr" onclick="api({op:'power'})">Power off</button>
      </div>
      <p class="hint">Powered-off TVs stop responding to everything except Wake-on-LAN (UDP magic packet to MAC <b>${TV_MAC}</b>).</p>
    </section>
    <section>
      <h2>Fault injection</h2>
      <div id="faults"></div>
      <p class="hint">ok = normal · slow = 2.5s delays · error = 500s · offline = drop connections. Watch Unimote react honestly.</p>
    </section>
    <section>
      <h2>Pairings</h2>
      <div id="pairings"><div class="row"><span>loading…</span></div></div>
      <div style="margin-top:8px">
        Vizio PIN mode:
        <button id="pinmode" onclick="api({op:'pin-mode'})"></button>
        <div class="pin" id="pin"></div>
      </div>
      <p class="hint">Samsung tokens &amp; LG client-keys appear here when Unimote pairs. Revoke to test re-pair flows.</p>
    </section>
  </div>
  <div style="display:flex;flex-direction:column;gap:16px">
    <section>
      <h2>Live protocol log</h2>
      <pre id="log"></pre>
    </section>
    <section>
      <h2>Button coverage — test EVERY button in Unimote</h2>
      <p class="hint">Each chip is a real protocol message Unimote should send. Press that button in Unimote and the chip lights up.</p>
      <div id="coverage">loading…</div>
    </section>
  </div>
</main>
<script>
let latestState, latestCoverage, latestEvents = [];

async function api(body) {
  await fetch('/api', { method: 'POST', body: JSON.stringify(body) });
}

function fmtT(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

function render() {
  if (!latestState) return;
  const s = latestState;
  document.getElementById('ips').textContent = window.location.hostname + '  (point Unimote at this IP)';
  const tv = document.getElementById('tv');
  const screen = document.getElementById('screen');
  const sub = document.getElementById('tvsub');
  if (s.power === 'off') {
    tv.className = 'tv off';
    screen.textContent = '⏻ OFF';
    sub.textContent = 'only Wake-on-LAN will reach me';
  } else {
    tv.className = 'tv';
    if (s.app) { screen.textContent = s.app; }
    else { screen.textContent = s.muted ? '🔇 ' + s.input : s.input; }
    sub.textContent = 'power: ' + s.power + ' · channel ' + s.channel + ' · volume ' + s.volume + (s.muted ? ' (muted)' : '');
  }
  document.getElementById('volbar').style.width = s.volume + '%';
  document.getElementById('pwr').textContent = s.power === 'off' ? 'Power on' : 'Power off';

  // faults
  const brands = ['roku','samsung','lg','vizio','sony','cast'];
  const modes = ['ok','slow','error','offline'];
  document.getElementById('faults').innerHTML = brands.map(b =>
    '<div><div style="font-size:11px;color:#93a4d0;margin-bottom:3px">' + b.toUpperCase() + '</div><div class="faults">' +
    modes.map(m => '<button class="' + (s.faults[b] === m ? 'on' : '') + '" onclick="api({op:\\'fault\\',tv:\\''+b+'\\',mode:\\''+m+'\\'})">' + m + '</button>').join('') +
    '</div></div>').join('');

  // pairings
  const sam = Object.entries(s.pairings.samsung);
  const lgk = Object.entries(s.pairings.lgClientKeys);
  const liveCounts = (window.__liveCounts || {});
  document.getElementById('pairings').innerHTML =
    '<div class="row"><span>Samsung tokens</span><span>' + (sam.length ? sam.length + ' active' : 'none') + '</span></div>' +
    '<div class="row"><span>LG client-keys</span><span>' + (lgk.length ? lgk.length + ' active' : 'none') + '</span></div>' +
    '<div class="row"><span>Vizio auth</span><span>' + (s.pairings.vizio.authToken ? 'paired' : 'unpaired') + '</span></div>' +'<div class="row"><span>Live sockets</span><span>' + (liveCounts.samsung || 0) + ' samsung · ' + (liveCounts.lg || 0) + ' lg</span></div>';

  document.getElementById('pinmode').textContent = s.pairings.vizio.pinMode === 'fixed' ? 'fixed (1234)' : 'random PINs';
  const pinEl = document.getElementById('pin');
  pinEl.textContent = s.pairings.vizio.pin ? 'PIN ' + s.pairings.vizio.pin : '';

  // log
  document.getElementById('log').innerHTML = latestEvents.slice(-120).reverse().map(e =>
    '<div><span class="t">' + fmtT(e.t) + '</span> [' + e.brand + '] ' + esc(e.message) + (e.detail ? ' · ' + esc(e.detail) : '') + '</div>').join('');

  // coverage
  if (latestCoverage) {
    const c = latestCoverage;
    document.getElementById('coverage').innerHTML = Object.keys(c).filter(k => k !== 'casts').map(b => {
      const cov = c[b];
      const pct = cov.expected ? Math.round(100 * cov.got / cov.expected) : 100;
      return '<div class="brand"><h3><span>' + b.toUpperCase() + '</span><span class="pct">' + pct + '% (' + cov.got + '/' + cov.expected + ')</span></h3>' +
        '<div class="chips">' + cov.expected.map(id =>
          '<span class="chip ' + (cov.done.includes(id) ? 'done' : '') + '" title="' + esc(id) + '">' + esc(id) + '</span>').join('') + '</div></div>';
    }).join('') +
    (c.casts.length ? '<div class="brand"><h3><span>CAST / LAUNCH EVENTS</span></h3><div class="chips">' + c.casts.map(x => '<span class="chip done">' + esc(JSON.stringify(x)) + '</span>').join('') + '</div></div>' : '');
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }

const es = new EventSource('/events');
es.onmessage = (m) => {
  const data = JSON.parse(m.data);
  if (data.state) latestState = data.state;
  if (data.live) window.__liveCounts = data.live;
  if (data.coverage) latestCoverage = data.coverage;
  if (data.event) { latestEvents.push(data.event); if (latestEvents.length > 250) latestEvents.shift(); }
  render();
};

fetch('/snapshot').then(r => r.json()).then(snap => {
  latestState = snap.state; latestCoverage = snap.coverage; latestEvents = snap.events; window.__liveCounts = snap.live || {};
  render();
});
</script>
</body>
</html>`;

function start() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (url.pathname === '/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state,
        coverage: coverageSnapshot(),
        events: state.events,
        live: live.counts(),
      }));
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
