#!/usr/bin/env node
/**
 * wol-send.js — send a Wake-on-LAN magic packet to the simulated TV.
 *
 *   node wol-send.js                    # wakes the simulator (MAC AA:BB:CC:DD:EE:FF)
 *   node wol-send.js AA:BB:CC:DD:EE:FF 192.168.1.255
 *
 * Useful for testing Unimote's Wake-on-LAN feature from a desktop, and for
 * verifying that the simulator's UDP listener powers the TV back on. (Unimote
 * itself can only do this from the native app — browsers cannot send UDP.)
 */
'use strict';

const dgram = require('dgram');

const mac = process.argv[2] || 'AA:BB:CC:DD:EE:FF';
const broadcast = process.argv[3] || '255.255.255.255';
const ports = [9, 7];

const clean = mac.replace(/[\s:.-]/g, '').toUpperCase();
if (!/^[0-9A-F]{12}$/.test(clean)) {
  console.error(`Invalid MAC: ${mac}`);
  process.exit(1);
}

const macBytes = Buffer.from(clean, 'hex');
const packet = Buffer.alloc(6 + 16 * 6);
packet.fill(0xff, 0, 6);
for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);

const sock = dgram.createSocket('udp4');
sock.bind(() => {
  sock.setBroadcast(true);
  let sent = 0;
  for (const port of ports) {
    sock.send(packet, 0, packet.length, port, broadcast, (err) => {
      if (err) console.error(`  ✗ port ${port}: ${err.message}`);
      else { sent++; console.log(`  ✓ magic packet -> ${broadcast}:${port} for ${mac}`); }
      if (sent + (err ? 1 : 0) >= ports.length) {
        setTimeout(() => { sock.close(); process.exit(sent ? 0 : 1); }, 100);
      }
    });
  }
});
