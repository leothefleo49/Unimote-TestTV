/**
 * Cast receiver info emulator - http://<pc>:8008
 *
 * Android TV / Google TV / Chromecast devices expose their identity at
 * /setup/eureka_info. Unimote uses it for detection, so the simulator serves
 * it to make the network scanner find an "Android TV" too (with honest
 * not-controllable messaging in the app).
 */
'use strict';

const http = require('http');
const { state, logEvent } = require('../lib/state');

function start(port = 8008, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (state.power === 'off' || state.faults.cast === 'offline') { req.socket.destroy(); return; }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (state.faults.cast === 'error') {
      res.writeHead(500, CORS); res.end(); return;
    }
    if (url.pathname === '/setup/eureka_info' || url.pathname === '/') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'PC TestTV (Android TV)',
        model: 'PC TestTV Google TV',
        manufacturer: 'TestTV',
        build_info: 'cast-stable-test',
        cast_build_revision: '2.0.0',
        ssid: 'TestLAN',
        capabilities: { bluetooth: true, display_out: true },
      }));
      if (url.pathname === '/setup/eureka_info') logEvent('cast', 'eureka_info served (Android TV detection)');
      return;
    }
    res.writeHead(404, CORS);
    res.end();
  });

  server.listen(port, host, () => logEvent('system', `Cast receiver info listening on ${host}:${port}`));
  return server;
}

module.exports = { start };
