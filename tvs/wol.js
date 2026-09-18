/**
 * Wake-on-LAN listener - UDP :9 / :7 (broadcast magic packets)
 *
 * When the simulated TV is powered OFF, a valid magic packet (6x 0xFF + 16x MAC)
 * powers it back on - so Unimote's Wake-on-LAN feature can be tested for real
 * (from the native app; browsers cannot send UDP).
 */
'use strict';

const dgram = require('dgram');
const { state, bus, logEvent } = require('../lib/state');

// The simulator's fake MAC. Put this in Unimote's WoL field:
const TV_MAC = 'AA:BB:CC:DD:EE:FF';

function start(ports = [9, 7]) {
  for (const port of ports) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg) => {
      if (msg.length !== 102) return;
      for (let i = 0; i < 6; i++) if (msg[i] !== 0xff) return;
      const macBytes = msg.subarray(6, 12);
      let matches = true;
      const expected = Buffer.from(TV_MAC.replace(/:/g, ''), 'hex');
      for (let i = 0; i < 6; i++) if (macBytes[i] !== expected[i]) matches = false;
      if (!matches) {
        logEvent('system', 'magic packet received for a different MAC (ignored)');
        return;
      }
      if (state.power === 'off') {
        state.power = 'on';
        bus.emit('state');
        logEvent('system', '★ Wake-on-LAN magic packet received -> TV powered ON');
      } else {
        logEvent('system', 'magic packet received (TV already on/standby)');
      }
    });
    sock.on('error', (e) => console.error(`[wol] udp ${port}: ${e.message}`));
    try {
      sock.bind(port, () => sock.setBroadcast(true));
    } catch (e) {
      console.error(`[wol] could not bind UDP ${port}: ${e.message}`);
    }
  }
  logEvent('system', `Wake-on-LAN listener on UDP ${ports.join('/')}`);
}

module.exports = { start, TV_MAC };
