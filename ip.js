#!/usr/bin/env node
/**
 * ip.js — print the addresses to type into Unimote, and check LAN reachability.
 *
 *   node ip.js
 *
 * Shows every LAN IPv4 on this PC, which one to use for Unimote, and whether a
 * typical "client isolation" apartment/router setup is likely to block your
 * phone from reaching this machine.
 */
'use strict';

const os = require('os');

const ifaces = [];
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4') ifaces.push({ name, address: a.address, internal: a.internal });
  }
}

const lan = ifaces.filter((i) => !i.internal);
const virtual = lan.filter((i) => /vEthernet|VirtualBox|VMware|Loopback|WSL|Hyper-V|Bluetooth/i.test(i.name));
const real = lan.filter((i) => !virtual.includes(i));

console.log('\n  Unimote TestTV — addresses\n');
if (real.length === 0) {
  console.log('  ⚠ No physical LAN IPv4 found. Are you connected to Wi-Fi/Ethernet?');
} else {
  real.forEach((i) => {
    console.log(`  →  ${i.address}   [${i.name}]   ← use THIS in Unimote (Settings → Connect → IP)`);
  });
}
if (virtual.length) {
  console.log('\n  (virtual adapters - not reachable from your phone, ignore these)');
  virtual.forEach((i) => console.log(`     ${i.address}   [${i.name}]`));
}

console.log(`
  Dashboard:   http://localhost:8520   (open on THIS PC)
  Wake-on-LAN: AA:BB:CC:DD:EE:FF       (Unimote's Wake TV field; native app only)

  ── If your phone cannot connect ────────────────────────────────────────────
  Most apartment/shared WiFi routers use "client isolation" (AP isolation): every
  device can reach the internet but NOT other devices on the same network. Symptom:
  the dashboard loads on the PC but the phone times out entering the IP above.

  Fix: use Windows Mobile Hotspot so the phone and PC share a private network.

    1. Windows Settings → Network & Internet → Mobile hotspot → turn it ON.
    2. On the phone, join the hotspot Wi-Fi ("<YourPCname>", the SSID shown).
    3. Run this script again and use the hotspot adapter's address (usually
       192.168.137.1) in Unimote. The dashboard + TVs are already listening on
       all interfaces, so nothing else needs restarting.

  Alternative: test on the PC itself. Open the Unimote web app in this machine's
  browser and enter 127.0.0.1 — everything works there even on an isolated network.
`);

// Quick self-check: are our own listeners up?
const net = require('net');

function probe(port, label) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
    sock.on('connect', () => { sock.destroy(); resolve(`  ✓ ${label} (port ${port}) is running`); });
    sock.on('timeout', () => { sock.destroy(); resolve(`  ✗ ${label} (port ${port}) not responding`); });
    sock.on('error', () => resolve(`  ✗ ${label} (port ${port}) is NOT running - start it with: node tv.js`));
  });
}

(async () => {
  const checks = await Promise.all([
    probe(8060, 'Roku'),
    probe(8001, 'Samsung'),
    probe(3000, 'LG'),
    probe(7345, 'Vizio'),
    probe(8520, 'Dashboard'),
  ]);
  console.log('\n  Simulator status');
  checks.forEach((c) => console.log(c));
  console.log('');
})();
