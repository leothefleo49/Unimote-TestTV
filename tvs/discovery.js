/**
 * SSDP responder — makes all simulated TVs discoverable exactly like real ones.
 *
 * Listens on UDP multicast 239.255.255.250:1900 for M-SEARCH queries and answers
 * with the same headers a real Roku / Chromecast / Samsung / LG / Vizio sends, so
 * Unimote's automatic discovery (native app: react-native-udp M-SEARCH) finds
 * these test TVs the same way it finds hardware.
 *
 * Also broadcasts periodic NOTIFY announcements, which is how real devices
 * announce themselves when a control point isn't actively searching.
 */
'use strict';

const dgram = require('dgram');
const os = require('os');
const { state, logEvent } = require('../lib/state');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// One responder per simulated device, mirroring what each brand actually answers.
function responders(ip) {
  return [
    {
      brand: 'Roku',
      st: 'roku:ecp',
      usn: `uuid:roku:ecp:TESTTVROKU001`,
      server: 'Roku/11.5.0 UPnP/1.0 Roku/11.5.0',
      location: `http://${ip}:8060/`,
      alive: () => state.power !== 'off' && state.faults.roku !== 'offline',
    },
    {
      brand: 'Chromecast/Google TV',
      st: 'urn:dial-multiscreen-org:service:dial:1',
      usn: 'uuid:TESTTVCAST001::urn:dial-multiscreen-org:service:dial:1',
      server: 'Linux/4.14 UPnP/1.0 CrKey/1.56',
      location: `http://${ip}:8008/setup/eureka_info`,
      alive: () => state.power !== 'off' && state.faults.cast !== 'offline',
    },
    {
      brand: 'Samsung',
      st: 'urn:samsung.com:device:RemoteControlReceiver:1',
      usn: 'uuid:TESTTVSAMSUNG1::urn:samsung.com:device:RemoteControlReceiver:1',
      server: 'Samsung UPnP/1.0 TIZEN/6.0',
      location: `http://${ip}:8001/api/v2/`,
      alive: () => state.power !== 'off' && state.faults.samsung !== 'offline',
    },
    {
      brand: 'Samsung MediaRenderer',
      st: 'urn:schemas-upnp-org:device:MediaRenderer:1',
      usn: 'uuid:TESTTVSAMSUNG1::urn:schemas-upnp-org:device:MediaRenderer:1',
      server: 'Samsung UPnP/1.0 TIZEN/6.0',
      location: `http://${ip}:8001/api/v2/`,
      alive: () => state.power !== 'off' && state.faults.samsung !== 'offline',
    },
    {
      brand: 'LG webOS',
      st: 'urn:schemas-upnp-org:device:MediaRenderer:1',
      usn: 'uuid:TESTTVLG00001::urn:schemas-upnp-org:device:MediaRenderer:1',
      server: 'WebOS/1.0 UPnP/1.0 LG-OLED55-TestTV/1.0',
      location: `http://${ip}:3000/`,
      alive: () => state.power !== 'off' && state.faults.lg !== 'offline',
    },
    {
      brand: 'Vizio',
      st: 'urn:dial-multiscreen-org:service:dial:1',
      usn: 'uuid:TESTTVVIZIO01::urn:dial-multiscreen-org:service:dial:1',
      server: 'Linux/4.9 UPnP/1.0 VIZIO SmartCast/2.0',
      location: `http://${ip}:7345/`,
      alive: () => state.power !== 'off' && state.faults.vizio !== 'offline',
    },
    {
      brand: 'Sony Bravia',
      st: 'urn:schemas-upnp-org:device:MediaRenderer:1',
      usn: 'uuid:TESTTVSONY001::urn:schemas-upnp-org:device:MediaRenderer:1',
      server: 'Sony UPnP/1.0 BRAVIA/1.0',
      location: `http://${ip}:80/`,
      alive: () => state.power !== 'off' && state.faults.sony !== 'offline',
    },
  ];
}

function lanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(a.interface || '')) {
        return a.address;
      }
    }
  }
  return '127.0.0.1';
}

function responseFor(r, ip, stRequested) {
  return [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'EXT:',
    `LOCATION: ${r.location}`,
    `SERVER: ${r.server}`,
    `ST: ${r.st === 'roku:ecp' ? 'roku:ecp' : (stRequested === 'ssdp:all' ? r.st : r.st)}`,
    `USN: ${r.usn}`,
    'BOOTID.UPNP.ORG: 1',
    '', '',
  ].join('\r\n');
}

function start(port = SSDP_PORT) {
  const ip = lanIp();
  const devices = responders(ip);
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return;
    const stMatch = text.match(/^ST:\s*(.+)$/im);
    const requested = stMatch ? stMatch[1].trim() : '';
    const key = requested.toLowerCase();
    const wantsAll = key === 'ssdp:all';

    const replies = devices.filter((d) => {
      if (!d.alive()) return false;
      if (wantsAll) return true;
      return d.st.toLowerCase() === key;
    });
    if (replies.length === 0) return;

    logEvent('system', `SSDP: answered M-SEARCH "${requested}" from ${rinfo.address} (${replies.length} device${replies.length > 1 ? 's' : ''})`);

    replies.forEach((d, i) => {
      const payload = Buffer.from(responseFor(d, ip, requested));
      setTimeout(() => {
        sock.send(payload, 0, payload.length, rinfo.port, rinfo.address, () => { /* ignore */ });
      }, i * 60);
    });
  });

  sock.on('error', (e) => console.error(`[ssdp] ${e.message}`));

  sock.bind(port, () => {
    try {
      sock.setBroadcast(true);
      sock.addMembership(SSDP_ADDR);
      logEvent('system', `SSDP responder listening on ${SSDP_ADDR}:${port} (advertising as ${ip})`);
    } catch (e) {
      console.error(`[ssdp] multicast join failed (unicast replies from clients may still work): ${e.message}`);
    }

    // Periodic NOTIFY announcements, like real devices.
    const announce = () => {
      if (state.power === 'off') return;
      for (const d of devices) {
        if (!d.alive()) continue;
        const notify = [
          'NOTIFY * HTTP/1.1',
          'HOST: 239.255.255.250:1900',
          'CACHE-CONTROL: max-age=1800',
          `LOCATION: ${d.location}`,
          `SERVER: ${d.server}`,
          `NT: ${d.st}`,
          'NTS: ssdp:alive',
          `USN: ${d.usn}`,
          '', '',
        ].join('\r\n');
        const buf = Buffer.from(notify);
        try {
          sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, () => { /* ignore */ });
        } catch { /* ignore */ }
      }
    };
    setTimeout(announce, 1500);
    setInterval(announce, 30000);
  });

  return sock;
}

module.exports = { start };
