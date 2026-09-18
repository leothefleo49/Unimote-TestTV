/**
 * live.js — registry of currently-open WebSocket channels per brand.
 *
 * Real TVs terminate established remote-control channels when you "forget" the
 * paired device. Revoking pairings in the dashboard therefore also drops every
 * live socket, which is what forces Unimote to go through a fresh handshake and
 * exercise its re-pair path.
 */
'use strict';

const live = {
  samsung: new Set(),
  lg: new Set(),
  lgPointer: new Set(),
};

function register(brand, conn) {
  if (!live[brand]) live[brand] = new Set();
  live[brand].add(conn);
  conn.addCloseHook(() => { live[brand].delete(conn); });
  return conn;
}

function closeAll(brand) {
  const set = live[brand];
  if (!set) return 0;
  let n = 0;
  for (const conn of [...set]) {
    try { conn.close(1000); } catch { /* ignore */ }
    set.delete(conn);
    n++;
  }
  return n;
}

function closeAllBrands() {
  let n = 0;
  for (const brand of Object.keys(live)) n += closeAll(brand);
  return n;
}

function counts() {
  const out = {};
  for (const brand of Object.keys(live)) out[brand] = live[brand].size;
  return out;
}

module.exports = { register, closeAll, closeAllBrands, counts };
