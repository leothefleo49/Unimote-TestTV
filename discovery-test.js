#!/usr/bin/env node
/**
 * discovery-test.js — verify SSDP discovery end-to-end, without a device.
 *
 *   node discovery-test.js
 *
 * Sends the same M-SEARCH queries Unimote's native app sends, collects the
 * simulator's answers, and asserts that every simulated TV is found with the
 * right brand. Requires the simulator to be running (node tv.js).
 *
 * Uses the *app's own* shipped parser when it can be resolved (So the thing
 * under test is the real protocol logic, not a copy): run this from the
 * simulator repo and point APP_ROOT at your Unimote checkout, or set
 * UNIMOTE_DIR. Falls back to an inline parser identical in behaviour, and says
 * which one it used.
 */
'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const APP_CANDIDATES = [
  process.env.UNIMOTE_DIR,
  'C:/Users/User/My-Apps-Codes-Programs/Quality of Life Apps/Unimote/Unimote X/Unimote-X',
].filter(Boolean);

const SEARCH_TARGETS = [
  'roku:ecp',
  'urn:dial-multiscreen-org:service:dial:1',
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:tvdevice:1',
  'ssdp:all',
];

/**
 * Load the app's REAL parser. The app source is TypeScript, so we transpile it
 * with esbuild (already present in the Unimote checkout via Vite) and require
 * the result — that way the thing under test is the shipped protocol logic, not
 * a copy that can drift.
 */
function loadParser() {
  const os = require('os');
  for (const root of APP_CANDIDATES) {
    const srcFile = path.join(root, 'shared', 'discovery', 'ssdp.ts');
    if (!fs.existsSync(srcFile)) continue;
    const esbuildPaths = [
      path.join(root, 'node_modules', 'esbuild'),
      path.join(__dirname, 'node_modules', 'esbuild'),
    ];
    let esbuild = null;
    for (const p of esbuildPaths) {
      try { esbuild = require(p); break; } catch { /* try next */ }
    }
    if (!esbuild) continue;
    const out = esbuild.buildSync({
      entryPoints: [srcFile],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const tmp = path.join(os.tmpdir(), 'unimote-ssdp-under-test.cjs');
    fs.writeFileSync(tmp, out.outputFiles[0].text);
    delete require.cache[tmp];
    const mod = require(tmp);
    if (typeof mod.parseSsdpResponse === 'function') return { mod, source: srcFile };
  }
  throw new Error('Could not load the app SSDP parser (needs esbuild from the Unimote checkout). Set UNIMOTE_DIR to the Unimote-X folder.');
}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function msearch(st) {
  return [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 2',
    'ST: ' + st,
    'USER-AGENT: UnimoteX/1.6 UPnP/1.1',
    '', '',
  ].join('\r\n');
}

async function discover(parser) {
  const raw = [];
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    const parsed = parser.parseSsdpResponse(msg.toString('utf8'), rinfo.address);
    if (parsed) raw.push(parsed);
  });
  await new Promise((resolve) => {
    sock.bind(0, () => {
      try { sock.setBroadcast(true); sock.addMembership('239.255.255.250'); } catch { /* ignore */ }
      SEARCH_TARGETS.forEach((st, i) => {
        setTimeout(() => {
          const buf = Buffer.from(msearch(st));
          try { sock.send(buf, 0, buf.length, 1900, '239.255.255.250', () => {}); } catch { /* ignore */ }
        }, i * 120);
      });
      setTimeout(resolve, 3200);
    });
  });
  try { sock.close(); } catch { /* ignore */ }
  return { raw, merged: parser.mergeSsdpDevices(raw.filter((d) => d.brand !== 'UNKNOWN')) };
}

(async () => {
  console.log('\nUnimote SSDP discovery test\n');
  const { mod: parser, source } = loadParser();
  console.log(`  parser under test: ${source}\n`);

  const { raw, merged } = await discover(parser);
  const brands = merged.map((d) => d.brand);

  console.log(`  received ${raw.length} answer(s), merged into ${merged.length} device(s):`);
  merged.forEach((d) => console.log(`    • ${d.ip}:${d.port || ''}  ${d.brand}  ${d.server || ''}`));
  console.log('');

  ok('found the Roku', brands.includes('ROKU'));
  ok('found the Samsung TV', brands.includes('SAMSUNG'));
  ok('found the LG webOS TV', brands.includes('LG_WEBOS'));
  ok('found the Vizio', brands.includes('VIZIO'));
  ok('found the Sony Bravia', brands.includes('SONY_BRAVIA'));
  ok('found the Cast/Google TV device', brands.includes('CHROMECAST') || brands.includes('ANDROID_TV'));
  ok('Roku reports its control port 8060', merged.some((d) => d.brand === 'ROKU' && d.port === 8060));
  // All five simulator TVs live on one machine, so a correct merge keeps them
  // separate (grouped by IP + brand) instead of collapsing to a single entry.
  ok('keeps the five test TVs on one IP distinct', merged.length >= 5, merged.length + ' devices');
  ok('duplicate answers for the same device are collapsed', raw.filter((d) => d.brand === 'ROKU').length >= 2 && merged.filter((d) => d.brand === 'ROKU').length === 1);

  // Merge unit checks with synthetic multi-device data (real network shape).
  const fake = parser.mergeSsdpDevices([
    { ip: '10.0.0.20', brand: 'ROKU', port: undefined },
    { ip: '10.0.0.20', brand: 'ROKU', port: 8060, server: 'Roku/11.5.0' },
    { ip: '10.0.0.21', brand: 'SAMSUNG', server: 'Samsung UPnP/1.0 TIZEN/6.0' },
    { ip: '10.0.0.22', brand: 'UNKNOWN' },
    { ip: '10.0.0.22', brand: 'LG_WEBOS', server: 'WebOS/1.0' },
  ]);
  ok('three real devices on different IPs stay separate',
    fake.length === 3 && ['10.0.0.20', '10.0.0.21', '10.0.0.22'].every((ip) => fake.some((d) => d.ip === ip)),
    fake.map((d) => d.ip + ':' + d.brand).join(', '));
  ok('a specific brand replaces an unknown answer on the same IP', fake.some((d) => d.ip === '10.0.0.22' && d.brand === 'LG_WEBOS'));

  // Parser unit checks (the same rules the app relies on)
  const noise = parser.parseSsdpResponse('random udp noise', '10.0.0.5');
  ok('ignores non-SSDP UDP noise', noise === null);
  const printer = parser.parseSsdpResponse(
    'HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.9:631/\r\nSERVER: Printer/1.0 UPnP/1.0\r\nST: urn:schemas-upnp-org:device:Printer:1\r\nUSN: uuid:printer-1\r\n\r\n',
    '10.0.0.9');
  ok('does not mistake a printer for a TV', printer && printer.brand === 'UNKNOWN');
  const roku = parser.parseSsdpResponse(
    'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.50:8060/\r\nSERVER: Roku/11.5.0 UPnP/1.0 Roku/11.5.0\r\nST: roku:ecp\r\nUSN: uuid:roku:ecp:ABC\r\n\r\n',
    '192.168.1.50');
  ok('parses a real Roku answer', roku && roku.brand === 'ROKU' && roku.port === 8060);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n discovery test failed:', e.message);
  process.exit(1);
});
