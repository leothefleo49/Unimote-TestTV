#!/usr/bin/env node
/**
 * Unimote TestTV — turn your PC into five TVs for testing Unimote X.
 *
 *   node tv.js            start everything (all brands + dashboard + WoL)
 *   node tv.js roku lg    start only some brands (plus the dashboard)
 *   node tv.js --help
 *
 * Zero dependencies. Node 16+.
 */
'use strict';

const brands = {
  roku: { label: 'Roku ECP', start: () => require('./tvs/roku').start(Number(process.env.ROKU_PORT || 8060)) },
  samsung: { label: 'Samsung Tizen (HTTP + WS)', start: () => require('./tvs/samsung').start(Number(process.env.SAMSUNG_PORT || 8001)) },
  lg: { label: 'LG webOS SSAP (WS + pointer socket)', start: () => require('./tvs/lg').start(Number(process.env.LG_PORT || 3000), Number(process.env.LG_POINTER_PORT || 3001)) },
  vizio: { label: 'Vizio SmartCast (pairing + AUTH)', start: () => require('./tvs/vizio').start(Number(process.env.VIZIO_PORT || 7345)) },
  sony: { label: 'Sony Bravia (JSON-RPC + IRCC SOAP)', start: () => require('./tvs/sony').start(Number(process.env.SONY_PORT || 80)) },
  cast: { label: 'Cast receiver info (Android TV detection)', start: () => require('./tvs/castinfo').start(Number(process.env.CAST_PORT || 8008)) },
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Unimote TestTV — your PC becomes a test bench of TVs for Unimote X.

Usage:
  node tv.js              start ALL brands + dashboard + Wake-on-LAN listener
  node tv.js roku lg …    start only the listed brands (+ dashboard)
  node tv.js --help

Brands: ${Object.keys(brands).join(', ')}

Ports (override with env vars):
  Roku 8060 · Samsung 8001 · LG 3000/3001 · Vizio 7345 · Sony 80
  Cast info 8008 · dashboard 8520 · Wake-on-LAN UDP 9/7

Then, in Unimote X: Settings → Connect → enter your PC's LAN IP.
Open the dashboard (it prints the URL at startup) to watch every button,
pairing, and connection attempt live — with per-brand coverage checklists.`);
  process.exit(0);
}

const wanted = args.filter((a) => brands[a]);
const selected = wanted.length ? wanted : Object.keys(brands);

console.log('');
console.log('  Unimote TestTV — starting');
console.log('  Brands: ' + selected.join(', '));

for (const key of selected) {
  try {
    brands[key].start();
  } catch (e) {
    console.error(`  ✗ ${key} failed to start: ${e.message}`);
  }
}

// SSDP responder: makes every simulated TV discoverable by automatic scanning
try {
  require('./tvs/discovery').start();
} catch (e) {
  console.error(`  ✗ SSDP responder failed: ${e.message}`);
}

// Wake-on-LAN listener (works while the "TV" is powered off)
try {
  require('./tvs/wol').start();
} catch (e) {
  console.error(`  ✗ WoL listener failed: ${e.message}`);
}

// Dashboard
require('./lib/dash').start();

console.log('  Press Ctrl+C to stop.');

// Port-conflict hints
process.on('uncaughtException', (e) => {
  if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ ${e.message}\n` +
      `    Another program is using that port, or it needs admin rights (port 80 for Sony).\n` +
      `    Run as Administrator, close the conflicting program, or set a custom port, e.g.:\n` +
      `      set SONY_PORT=8080 && node tv.js sony\n`);
  } else {
    console.error('  Uncaught:', e);
  }
});
