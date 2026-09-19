/**
 * state.js - shared TV state, event bus, and the button-coverage tracker.
 *
 * The dashboard and every protocol server read/write this one store, so a key
 * pressed in Unimote shows up instantly in the dashboard AND ticks its entry
 * in the per-brand coverage checklist.
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const state = {
  power: 'on',            // 'on' | 'off'  (off = all TV servers stop responding; WoL turns back on)
  volume: 14,             // 0..100
  muted: false,
  channel: 7,
  input: 'HDMI 1',
  app: null,              // e.g. 'Netflix', 'YouTube', 'Browser: https://…'
  faults: {
    // per brand: 'ok' | 'slow' | 'error' | 'offline'
    roku: 'ok', samsung: 'ok', lg: 'ok', vizio: 'ok', sony: 'ok', cast: 'ok',
  },
  pairings: {
    // Samsung: token -> { name, issuedAt }
    samsung: {},
    lgClientKeys: {},      // key -> { issuedAt }
    vizio: { authToken: null, pairReqToken: null, pin: null, pinMode: 'fixed' },
  },
  events: [],              // last 250 protocol events for the dashboard
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

const COVERAGE = {
  roku: [
    'Power', 'PowerOff', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'Home', 'Back',
    'Up', 'Down', 'Left', 'Right', 'Select', 'Play', 'Pause', 'Rev', 'Fwd',
    'ChannelUp', 'ChannelDown', 'Info', 'Enter', 'Backspace', 'Search',
    'Lit_0', 'Lit_1', 'Lit_5', 'Lit_9',
    'launch:12', 'launch:837', 'launch:13', 'launch:2285', 'launch:2915',
    'search:browse',
  ],
  samsung: [
    'KEY_POWER', 'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE', 'KEY_HOME', 'KEY_RETURN',
    'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER',
    'KEY_CHUP', 'KEY_CHDOWN', 'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP',
    'KEY_REWIND', 'KEY_FF', 'KEY_INFO', 'KEY_MENU', 'KEY_SOURCE',
    'KEY_NETFLIX', 'KEY_YOUTUBE', 'KEY_0', 'KEY_1', 'KEY_9',
    'RunApp:org.tizen.browser',
  ],
  lg: [
    'ssap://audio/volumeUp', 'ssap://audio/volumeDown', 'ssap://audio/getMute',
    'ssap://audio/setMute', 'ssap://tv/channelUp', 'ssap://tv/channelDown',
    'ssap://media.controls/play', 'ssap://media.controls/pause',
    'ssap://media.controls/stop', 'ssap://media.controls/rewind',
    'ssap://media.controls/fastForward', 'ssap://system/turnOff',
    'button:UP', 'button:DOWN', 'button:LEFT', 'button:RIGHT', 'button:ENTER',
    'button:BACK', 'button:HOME', 'button:MUTE',
    'ime/insertText', 'ime/sendEnterKey', 'ime/sendDeleteKey',
    'launch:netflix', 'launch:youtube.leanback.v4', 'launch:com.webos.app.browser',
    'launch:com.webos.app.miracast', 'launch:com.webos.app.search',
    'getPointerInputSocket',
  ],
  vizio: [
    'key:11:0', 'key:11:1', 'key:11:2',       // power off/on/toggle
    'key:7:1',                                 // input
    'key:3:8', 'key:3:0', 'key:3:1', 'key:3:7', 'key:3:2', // up/down/left/right/ok
    'key:4:0', 'key:4:3', 'key:4:6', 'key:4:8',            // back/home/info/menu
    'key:5:1', 'key:5:0', 'key:5:3',           // vol up/down/mute
    'key:8:1', 'key:8:0',                      // channel up/down
    'key:2:3', 'key:2:2', 'key:2:0', 'key:2:4', 'key:2:5', // media
    'pairing:start', 'pairing:pair',
  ],
  sony: [
    'IRCC:power', 'IRCC:home', 'IRCC:back', 'IRCC:up', 'IRCC:down', 'IRCC:left',
    'IRCC:right', 'IRCC:ok', 'IRCC:volume_up', 'IRCC:volume_down', 'IRCC:mute',
    'IRCC:play', 'IRCC:pause', 'IRCC:input', 'system:getSystemInformation',
  ],
};

const coverage = {
  roku: new Set(), samsung: new Set(), lg: new Set(),
  vizio: new Set(), sony: new Set(), casts: [],
};

function logEvent(brand, message, detail) {
  const event = { t: Date.now(), brand, message, detail };
  state.events.push(event);
  if (state.events.length > 250) state.events.shift();
  bus.emit('event', event);
}

/** Record a covered protocol item (idempotent). */
function markCoverage(brand, id) {
  if (coverage[brand] && !coverage[brand].has(id)) {
    coverage[brand].add(id);
    logEvent(brand, 'coverage', id);
    bus.emit('coverage');
  }
}

function coverageSnapshot() {
  const out = {};
  for (const brand of Object.keys(COVERAGE)) {
    const expected = COVERAGE[brand];
    const got = expected.filter((id) => coverage[brand].has(id));
    out[brand] = {
      expected: expected.length,          // count
      expectedIds: expected,              // every id that SHOULD be hit (UI chips)
      got: got.length,                    // count
      done: got,                          // ids actually received
      missing: expected.filter((id) => !coverage[brand].has(id)),
    };
  }
  out.casts = coverage.casts;
  return out;
}

function newToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function resetCoverage() {
  for (const brand of Object.keys(coverage)) {
    if (coverage[brand] instanceof Set) coverage[brand].clear();
  }
  coverage.casts.length = 0;
  bus.emit('coverage');
}

function resetPairings() {
  state.pairings.samsung = {};
  state.pairings.lgClientKeys = {};
  state.pairings.vizio = { authToken: null, pairReqToken: null, pin: null, pinMode: state.pairings.vizio.pinMode };
  logEvent('system', 'All pairings revoked (Samsung tokens, LG client keys, Vizio auth)');
}

function resetState() {
  state.power = 'on';
  state.volume = 14;
  state.muted = false;
  state.channel = 7;
  state.input = 'HDMI 1';
  state.app = null;
  for (const k of Object.keys(state.faults)) state.faults[k] = 'ok';
  resetPairings();
  resetCoverage();
  state.events.length = 0;
  logEvent('system', 'Simulator state reset');
}

/** Apply TV-state semantics shared by every brand (volume clamp, app tracking). */
function applyKeyEffect(brand, effect) {
  if (state.power === 'off') return false;
  if (effect.type === 'volume') {
    state.volume = Math.max(0, Math.min(100, state.volume + effect.delta));
    state.muted = false;
  } else if (effect.type === 'mute') {
    state.muted = !state.muted;
  } else if (effect.type === 'channel') {
    state.channel = Math.max(1, Math.min(999, state.channel + effect.delta));
  } else if (effect.type === 'app') {
    state.app = effect.app;
  } else if (effect.type === 'home') {
    state.app = null;
    state.input = 'Home';
  } else if (effect.type === 'power') {
    // Dashboard-driven power off is simulated; a power keypress toggles standby
    // state but the servers stay alive (like a real TV in network-standby).
    state.power = state.power === 'on' ? 'standby' : 'on';
  }
  bus.emit('state');
  return true;
}

module.exports = {
  state, bus, logEvent, markCoverage, coverageSnapshot,
  newToken, resetCoverage, resetPairings, resetState, applyKeyEffect, COVERAGE,
};
