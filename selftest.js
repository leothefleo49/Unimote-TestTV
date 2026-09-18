#!/usr/bin/env node
/**
 * selftest.js — exercises every protocol the simulator serves, without Unimote.
 *
 *   node selftest.js [host]
 *
 * Proves the simulator itself is correct: HTTP surfaces, the WebSocket
 * handshakes (Samsung token issue/reject, LG register + pointer socket),
 * Vizio's 401 -> PIN -> AUTH flow, and Sony IRCC. Exits non-zero on failure.
 * Uses only Node built-ins + the local minws client logic (raw http/socket).
 */
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const HOST = process.argv[2] || '127.0.0.1';
let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, path, method, headers, timeout: 6000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Minimal RFC 6455 client handshake (mirrors lib/minws framing). */
function wsConnect(port, path, { onMessage, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, HOST);
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const sent = [];
    let closed = false;

    const finish = (err, api) => {
      if (handshakeDone || closed) return;
      if (err) { closed = true; socket.destroy(); reject(err); return; }
      handshakeDone = true;
      resolve(api);
    };

    const timer = setTimeout(() => finish(new Error('handshake timeout')), timeoutMs);
    socket.on('error', (e) => { if (!handshakeDone) { clearTimeout(timer); finish(e); } });
    socket.on('close', () => { if (!handshakeDone) { clearTimeout(timer); finish(new Error('closed before open')); } });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buffer.subarray(0, idx).toString();
        buffer = buffer.subarray(idx + 4);
        clearTimeout(timer);
        if (!/101/.test(head)) { finish(new Error('bad handshake: ' + head.split('\r\n')[0])); return; }
        const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!head.includes(expected)) { finish(new Error('bad accept key')); return; }
        const api = {
          send(text) {
            const payload = Buffer.from(text, 'utf8');
            const mask = crypto.randomBytes(4);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
            let header;
            if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
            else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
            socket.write(Buffer.concat([header, mask, masked]));
            sent.push(text);
          },
          close() { try { socket.destroy(); } catch {} },
          messages: [],
        };
        // Parse incoming text frames
        api._pump = setInterval(() => {
          for (;;) {
            if (buffer.length < 2) break;
            const len0 = buffer[1] & 0x7f;
            let len = len0, off = 2;
            if (len0 === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); off = 4; }
            else if (len0 === 127) { if (buffer.length < 10) break; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
            if (buffer.length < off + len) break;
            const text = buffer.subarray(off, off + len).toString('utf8');
            buffer = buffer.subarray(off + len);
            try { onMessage && onMessage(text); } catch { /* ignore */ }
          }
        }, 20);
        finish(null, api);
      }
    });

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${HOST}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nUnimote TestTV selftest against ${HOST}\n`);

  // ---------- Roku ----------
  console.log('Roku ECP (8060)');
  {
    const info = await request(8060, '/query/device-info');
    ok('device-info returns XML identity', info.status === 200 && info.body.includes('<friendly-device-name>PC TestTV (Roku)'));
    const key = await request(8060, '/keypress/VolumeUp', { method: 'POST' });
    ok('valid keypress accepted', key.status === 200);
    const bad = await request(8060, '/keypress/NotAKey', { method: 'POST' });
    ok('unknown keypress rejected (404 like a real Roku)', bad.status === 404);
    const launch = await request(8060, '/launch/837?contentId=abc123&mediaType=video', { method: 'POST' });
    ok('YouTube deep-link launch accepted', launch.status === 200);
    const search = await request(8060, '/search/browse?keyword=test', { method: 'POST' });
    ok('search accepted', search.status === 200);
  }

  // ---------- Samsung ----------
  console.log('\nSamsung Tizen (8001)');
  let samsungToken = null;
  {
    const api = await request(8001, '/api/v2/');
    ok('HTTP /api/v2/ identity', api.status === 200 && api.body.includes('TESTTVSAMSUNG1'));

    const messages = [];
    const ws = await wsConnect(8001, '/api/v2/channels/samsung.remote.control?name=' + Buffer.from('SelftestRemote').toString('base64'), {
      onMessage: (m) => messages.push(JSON.parse(m)),
    });
    await sleep(250);
    const connect = messages.find((m) => m.event === 'ms.channel.connect');
    ok('WS issues ms.channel.connect', !!connect);
    samsungToken = connect && connect.data && connect.data.token;
    ok('token issued on first pairing', !!samsungToken, samsungToken ? samsungToken.slice(0, 8) + '…' : '');
    ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
    await sleep(200);
    ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'RunApp', AppType: 'DEEP_LINK', AppId: 'org.tizen.browser', MetaTag: 'https://example.com' } }));
    await sleep(200);
    ws.close();

    // Reconnect WITH the token -> silent accept
    const messages2 = [];
    const ws2 = await wsConnect(8001, '/api/v2/channels/samsung.remote.control?name=' + Buffer.from('SelftestRemote').toString('base64') + '&token=' + samsungToken, {
      onMessage: (m) => messages2.push(JSON.parse(m)),
    });
    await sleep(250);
    ok('valid token reconnects silently', messages2.some((m) => m.event === 'ms.channel.connect'));
    ws2.close();

    // Reconnect with a bogus token -> unauthorized
    const messages3 = [];
    const ws3 = await wsConnect(8001, '/api/v2/channels/samsung.remote.control?name=x&token=deadbeef', {
      onMessage: (m) => messages3.push(JSON.parse(m)),
    });
    await sleep(250);
    ok('revoked/unknown token -> ms.channel.unauthorized', messages3.some((m) => m.event === 'ms.channel.unauthorized'));
    ws3.close();
  }

  // ---------- LG ----------
  console.log('\nLG webOS SSAP (3000/3001)');
  let lgClientKey = null;
  {
    const messages = [];
    const ws = await wsConnect(3000, '/', { onMessage: (m) => messages.push(JSON.parse(m)) });
    ws.send(JSON.stringify({ type: 'register', id: 1, payload: { forcePairing: false, pairingType: 'PROMPT' } }));
    await sleep(300);
    const reg = messages.find((m) => m.type === 'registered');
    ok('register -> registered', !!reg);
    lgClientKey = reg && reg.payload && reg.payload['client-key'];
    ok('client-key issued', !!lgClientKey, lgClientKey ? lgClientKey.slice(0, 8) + '…' : '');

    ws.send(JSON.stringify({ type: 'request', id: 'r1', uri: 'ssap://audio/volumeUp', payload: {} }));
    await sleep(200);
    ok('ssap://audio/volumeUp answered', messages.some((m) => m.id === 'r1' && m.type === 'response'));

    ws.send(JSON.stringify({ type: 'request', id: 'r2', uri: 'ssap://com.webos.remote.input/getPointerInputSocket', payload: {} }));
    await sleep(250);
    const pointer = messages.find((m) => m.id === 'r2');
    const socketPath = pointer && pointer.payload && pointer.payload.socketPath;
    ok('pointer input socket provided', !!socketPath, socketPath || '');

    ws.send(JSON.stringify({ type: 'request', id: 'r3', uri: 'ssap://system.launcher/launch', payload: { id: 'netflix' } }));
    await sleep(200);
    ok('app launch answered', messages.some((m) => m.id === 'r3'));

    // Pointer socket: D-pad button
    const pointerMessages = [];
    const pws = await wsConnect(3001, '/pointer', { onMessage: (m) => pointerMessages.push(JSON.parse(m)) });
    await sleep(200);
    ok('pointer socket announces itself', pointerMessages.some((m) => m.type === 'pointerInputSocket'));
    pws.send(JSON.stringify({ type: 'button', name: 'ENTER' }));
    await sleep(200);
    pws.close();
    ws.close();

    // Wrong client-key -> denied
    const denied = [];
    const wsBad = await wsConnect(3000, '/', { onMessage: (m) => denied.push(JSON.parse(m)) });
    wsBad.send(JSON.stringify({ type: 'register', id: 2, payload: { 'client-key': 'not-a-real-key' } }));
    await sleep(300);
    ok('revoked client-key -> error', denied.some((m) => m.type === 'error'));
    wsBad.close();
  }

  // ---------- Vizio ----------
  console.log('\nVizio SmartCast (7345)');
  {
    const unauth = await request(7345, '/state/device/power_mode');
    ok('unauthenticated state read -> 401', unauth.status === 401);

    const start = await request(7345, '/pairing/start', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ DEVICE_NAME: 'Selftest', DEVICE_ID: 'selftest-1' }) });
    const startJson = JSON.parse(start.body);
    ok('pairing/start succeeds', start.status === 200 && startJson.STATUS && startJson.STATUS.RESULT === 'SUCCESS');
    const reqToken = startJson.STATUS.PAIRING_REQ_TOKEN;

    const badPin = await request(7345, '/pairing/pair', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ DEVICE_ID: 'selftest-1', PAIRING_REQ_TOKEN: reqToken, CHALLENGE_TYPE: 'PIN', RESPONSE_VALUE: '0000' }) });
    ok('wrong PIN rejected', JSON.parse(badPin.body).STATUS.RESULT === 'FAILED');

    const goodPin = await request(7345, '/pairing/pair', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ DEVICE_ID: 'selftest-1', PAIRING_REQ_TOKEN: reqToken, CHALLENGE_TYPE: 'PIN', RESPONSE_VALUE: '1234' }) });
    const goodJson = JSON.parse(goodPin.body);
    const authToken = goodJson.ITEMS && goodJson.ITEMS[0] && goodJson.ITEMS[0].AUTH_TOKEN;
    ok('correct PIN returns AUTH token', !!authToken);

    const authed = await request(7345, '/key_command/', { method: 'PUT', headers: { 'Content-Type': 'application/json', AUTH: authToken }, body: JSON.stringify({ KEYLIST: [{ CODESET: 5, CODE: 1, ACTION: 'KEYPRESS' }] }) });
    ok('authenticated key_command accepted', authed.status === 200 && JSON.parse(authed.body).STATUS.RESULT === 'SUCCESS');

    const stateRead = await request(7345, '/state/device/power_mode', { headers: { AUTH: authToken } });
    const st = JSON.parse(stateRead.body);
    ok('authenticated power_mode readable', stateRead.status === 200 && st.ITEMS && st.ITEMS[0] && st.ITEMS[0].VALUE === 'ON');
  }

  // ---------- Sony ----------
  console.log('\nSony Bravia (80)');
  {
    const sys = await request(80, '/sony/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'getSystemInformation', id: 1, params: [], version: '1.0' }) });
    ok('getSystemInformation responds', sys.status === 200 && sys.body.includes('PC-TestTV-BRAVIA'));
    const probe = await request(80, '/sony/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok('bare probe still identifies Sony', probe.status === 200 && probe.body.includes('error'));
    const ircc = await request(80, '/sony/IRCC', { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: '<s:Envelope><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>AAAAAQAAAAEAAAASAw==</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>' });
    ok('IRCC volume_up accepted', ircc.status === 200 && ircc.body.includes('X_SendIRCCResponse'));
  }

  // ---------- Cast info ----------
  console.log('\nCast receiver info (8008)');
  {
    const eureka = await request(8008, '/setup/eureka_info');
    ok('eureka_info identity', eureka.status === 200 && eureka.body.includes('PC TestTV (Android TV)'));
  }

  // ---------- Dashboard ----------
  console.log('\nDashboard (8520)');
  {
    const page = await request(8520, '/');
    ok('dashboard page serves', page.status === 200 && page.body.includes('Unimote TestTV'));
    const snap = await request(8520, '/snapshot');
    const snapJson = JSON.parse(snap.body);
    ok('snapshot has state + coverage', !!snapJson.state && !!snapJson.coverage);
    ok('coverage tracked the test buttons',
      snapJson.coverage.roku.got > 0 && snapJson.coverage.samsung.got > 0 && snapJson.coverage.lg.got > 0 && snapJson.coverage.vizio.got > 0,
      `roku ${snapJson.coverage.roku.got}/${snapJson.coverage.roku.expected}, samsung ${snapJson.coverage.samsung.got}/${snapJson.coverage.samsung.expected}, lg ${snapJson.coverage.lg.got}/${snapJson.coverage.lg.expected}, vizio ${snapJson.coverage.vizio.got}/${snapJson.coverage.vizio.expected}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nselftest crashed:', e.message);
  process.exit(1);
});
