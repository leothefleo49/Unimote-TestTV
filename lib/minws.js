/**
 * minws.js - a minimal, dependency-free RFC 6455 WebSocket server.
 *
 * Just enough protocol for local-TV remote channels: text frames (with
 * fragmentation), ping/pong, and clean closes. Samsung (8001) and LG SSAP
 * (3000/3001) only exchange small JSON text frames, so this covers everything
 * Unimote sends.
 */
'use strict';

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.closed = false;
    this.handleFrame = null;
    this.onclose = null;
    /** Additional close callbacks (registry cleanup, etc.) - all are invoked. */
    this._closeHooks = [];

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
    socket.setNoDelay(true);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Parse as many complete frames as are available.
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._processFrame(frame);
      if (this.closed) break;
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(16 * 1024 * 1024)) { this.close(1009); return null; }
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
      payload = unmasked;
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _processFrame(frame) {
    switch (frame.opcode) {
      case 0x0: // continuation
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const whole = Buffer.concat(this.fragments);
          const opcode = this.fragOpcode;
          this.fragments = [];
          this.fragOpcode = 0;
          if (opcode === 0x1) this._emitMessage(whole);
        }
        break;
      case 0x1: // text
      case 0x2: // binary
        if (frame.fin) {
          if (frame.opcode === 0x1) this._emitMessage(frame.payload);
        } else {
          this.fragments.push(frame.payload);
          this.fragOpcode = frame.opcode;
        }
        break;
      case 0x8: // close
        this._sendFrame(0x8, frame.payload.subarray(0, 2));
        this._teardown();
        break;
      case 0x9: // ping -> pong
        this._sendFrame(0xA, frame.payload);
        break;
      case 0xA: // pong
        break;
      default:
        this.close(1002);
    }
  }

  _emitMessage(payload) {
    try {
      if (this.handleFrame) this.handleFrame(payload.toString('utf8'));
    } catch (e) {
      console.error('[minws] handler error:', e.message);
    }
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch { /* dead socket */ }
  }

  /** Send a text message. */
  send(text) {
    this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  /** Send a protocol-level ping (liveness). */
  ping() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this._sendFrame(0x8, body);
    this._teardown();
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch { /* ignore */ }
    if (this.onclose) this.onclose();
    for (const hook of this._closeHooks) {
      try { hook(); } catch { /* ignore */ }
    }
  }

  /** Register an extra close callback (kept alongside conn.onclose). */
  addCloseHook(fn) {
    this._closeHooks.push(fn);
  }
}

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 * Only `path` is matched; everything else is destroyed.
 */
function attach(httpServer, path, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const url = req.url || '/';
    if (url.split('?')[0] !== path) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );
    const conn = new WsConnection(socket);
    try {
      onConnection(conn, req);
    } catch (e) {
      console.error('[minws] connection handler error:', e.message);
      conn.close(1011);
    }
  });
}

module.exports = { attach, WsConnection };
