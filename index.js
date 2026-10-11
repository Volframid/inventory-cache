'use strict';

const fs = require('fs');
const path = require('path');
const DEFAULTS = { enabled: true, measure: false, maxCacheBytes: 8388608,
  maxListBytes: 2097152, maxEntries: 128, maxChunksPerList: 128, partialTimeoutMs: 5000 };
const LAST = { order: Number.MAX_SAFE_INTEGER, filter: { fake: null, modified: null, silenced: null } };

module.exports = function InventoryCache(mod) {
  const file = path.join(__dirname, 'config.json'), hooks = [], cache = new Map(), visible = new Map();
  let config = readConfig(true), active = null, timer = null, cachedBytes = 0;
  let player = null, replayDepth = 0, closed = false, stats = counters();
  let supported = false;
  try { supported = mod.dispatch.resolve('S_ITEMLIST', '*').version === 4; }
  catch (error) { mod.warn('InventoryCache: packet definition unavailable; packets will pass through.'); }
  if (!supported) mod.warn('InventoryCache: requires S_ITEMLIST v4; filtering is inactive for this definition.');

  function counters() {
    return { since: Date.now(), received: 0, receivedBytes: 0, passed: 0, passedBytes: 0,
      suppressed: 0, suppressedBytes: 0, replayed: 0, replayedBytes: 0, replayFailures: 0,
      malformed: 0, foreign: 0, orphaned: 0, interrupted: 0, timedOut: 0, oversized: 0,
      evicted: 0, resets: 0, measured: 0, processingNs: 0, peakNs: 0 };
  }
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a settings object');
    const result = Object.assign({}, DEFAULTS, value);
    for (const key of ['enabled', 'measure']) if (typeof result[key] !== 'boolean') throw Error(key + ' must be true or false');
    for (const [key, min, max] of [['maxCacheBytes',65536,67108864], ['maxListBytes',65536,16777216],
      ['maxEntries',1,1024], ['maxChunksPerList',1,1024], ['partialTimeoutMs',1000,30000]]) {
      if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw Error('Invalid ' + key);
    }
    if (result.maxListBytes > result.maxCacheBytes) throw Error('maxListBytes must not exceed maxCacheBytes');
    return result;
  }
  function save(value) {
    const text = JSON.stringify(value, null, 2) + '\n', temporary = file + '.tmp';
    let fd;
    try { fd = fs.openSync(temporary, 'w'); fs.writeFileSync(fd, text); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function readConfig(startup) {
    try {
      let bytes = fs.readFileSync(file), text;
      if (bytes[0] === 255 && bytes[1] === 254) text = bytes.slice(2).toString('utf16le');
      else if (bytes[0] === 254 && bytes[1] === 255) text = Buffer.from(bytes.slice(2)).swap16().toString('utf16le');
      else text = bytes.toString('utf8');
      return validate(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (error) {
      if (!startup) throw error;
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, file + '.invalid-' + Date.now() + '.bak', fs.constants.COPYFILE_EXCL); }
        catch (backupError) { mod.warn('InventoryCache: invalid settings kept; using defaults in memory.'); return Object.assign({}, DEFAULTS); }
        mod.warn('InventoryCache: invalid settings backed up; using defaults.');
      }
      const result = Object.assign({}, DEFAULTS);
      try { save(result); } catch (writeError) { mod.warn('InventoryCache: could not save settings: ' + writeError.message); }
      return result;
    }
  }
  function setPlayer(id) { player = typeof id === 'bigint' ? id : null; }
  function clearTimer() { if (timer !== null) mod.clearTimeout(timer); timer = null; }
  function drop(key) {
    const prior = cache.get(key);
    if (prior) { cachedBytes -= prior.bytes; cache.delete(key); }
  }
  function commit(list) {
    drop(list.key);
    if (list.replayFailed) return;
    while (cache.size >= config.maxEntries || cachedBytes + list.bytes > config.maxCacheBytes) {
      const key = cache.keys().next().value;
      if (key === undefined) return;
      drop(key); stats.evicted++;
    }
    cache.set(list.key, { chunks: list.chunks, bytes: list.bytes }); cachedBytes += list.bytes;
  }
  function replayPrefix(list) {
    if (!list || list.passthrough) return;
    // State changes before sending, so our own replay cannot recurse into it.
    list.passthrough = true; replayDepth++;
    try {
      for (const data of list.chunks) {
        try {
          if (mod.toClient(data) === false) { stats.replayFailures++; list.replayFailed = true; }
          else { stats.replayed++; stats.replayedBytes += data.length; }
        } catch (error) { stats.replayFailures++; list.replayFailed = true;
          mod.warn('InventoryCache: prefix replay failed: ' + error.message); }
      }
    } finally { replayDepth--; }
  }
  function abandon(replay, reason) {
    const prior = active; active = null; clearTimer();
    if (prior) { drop(prior.key); if (replay) replayPrefix(prior); if (reason) stats[reason]++; }
  }
  function reset(replay) {
    abandon(replay); cache.clear(); cachedBytes = 0; visible.clear(); stats.resets++;
  }
  function armPartial() {
    clearTimer();
    timer = mod.setTimeout(() => { timer = null; abandon(true, 'timedOut'); }, config.partialTimeoutMs);
  }
  function header(data, code) {
    if (data.length < 49 || data.readUInt16LE(0) !== data.length || data.readUInt16LE(2) !== code) return null;
    for (let i = 44; i <= 48; i++) if (data[i] > 1) return null;
    const count = data.readUInt16LE(4), offset = data.readUInt16LE(6);
    if (count && (offset < 49 || offset + 4 > data.length)) return null;
    return { player: data.readBigUInt64LE(8), container: data.readInt32LE(16), pocket: data.readInt32LE(20),
      numPockets: data.readInt32LE(24), moneyLow: data.readUInt32LE(32), moneyHigh: data.readUInt32LE(36),
      open: Boolean(data[44]), requested: Boolean(data[45]), first: Boolean(data[46]), more: Boolean(data[47]) };
  }
  function sameBase(a, b) {
    return a && a.numPockets === b.numPockets && a.moneyLow === b.moneyLow && a.moneyHigh === b.moneyHigh;
  }
  function markVisible(h) {
    visible.delete(h.container); visible.set(h.container, h);
    while (visible.size > config.maxEntries) visible.delete(visible.keys().next().value);
  }
  function passed(data) { stats.passed++; stats.passedBytes += data.length; }
  function handle(code, data) {
    if (closed || replayDepth || !supported || player === null) return;
    const h = header(data, code);
    if (!h) { stats.malformed++; reset(true); return; }
    if (h.player !== player) return;
    if (data.$fake) stats.foreign++;
    else { stats.received++; stats.receivedBytes += data.length; }
    const key = h.container + ':' + h.pocket;
    // Foreign synthetic or blocked data can change what the client has seen.
    // Never suppress or cache it, and never undo another hook's suppression.
    if (data.$fake || data.$silenced) {
      abandon(true, 'interrupted'); drop(key);
      if (!data.$silenced) { markVisible(h); passed(data); }
      else visible.delete(h.container);
      return;
    }
    if (!config.enabled) { passed(data); return; }
    if (h.first) {
      if (active) abandon(true, 'interrupted');
      active = { key, previous: cache.get(key), chunks: [], bytes: 0,
        passthrough: h.requested || h.open || !sameBase(visible.get(h.container), h) };
      if (!active.previous) active.passthrough = true;
    } else if (!active || active.key !== key) {
      abandon(true, 'interrupted'); drop(key); markVisible(h); stats.orphaned++; passed(data); return;
    }
    const list = active;
    if (list.bytes + data.length > config.maxListBytes || list.chunks.length >= config.maxChunksPerList) {
      abandon(true, 'oversized'); markVisible(h); passed(data); return;
    }
    const old = list.previous && list.previous.chunks[list.chunks.length];
    const equal = !list.passthrough && old && old.equals(data);
    if (!equal) replayPrefix(list);
    const suppress = Boolean(equal);
    // Raw dispatch gives this hook its own Buffer. Matching chunks reuse the
    // immutable cache buffer; changed chunks retain the supplied copy once.
    list.chunks.push(suppress ? old : data); list.bytes += data.length;
    if (!suppress) { markVisible(h); passed(data); }
    else { stats.suppressed++; stats.suppressedBytes += data.length; }
    if (h.more) armPartial();
    else { active = null; clearTimer(); commit(list); }
    if (suppress) return false;
  }
  function hook(...args) { const value = mod.hook(...args); hooks.push(value); }
  hook('S_ITEMLIST', 'raw', LAST, (code, data) => {
    const start = config.measure && !replayDepth ? process.hrtime.bigint() : null;
    try { return handle(code, data); }
    finally { if (start !== null) { const elapsed = Number(process.hrtime.bigint() - start);
      stats.measured++; stats.processingNs += elapsed; stats.peakNs = Math.max(stats.peakNs, elapsed); } }
  });
  hook('S_LOGIN', 14, { order: Number.MAX_SAFE_INTEGER, filter: { fake: false, silenced: null } }, event => {
    reset(false); setPlayer(event.gameId);
  });
  hook('S_RETURN_TO_LOBBY', 'event', { filter: { fake: false, silenced: null } }, () => { reset(false); setPlayer(null); });
  hook('S_LOAD_TOPO', 'event', { filter: { fake: false, silenced: null } }, () => { reset(false); });
  // Core game-state is optional here; it only supplies identity on a hot load.
  if (mod.game && mod.game.me) setPlayer(mod.game.me.gameId);

  function message(text) { mod.command.message(text); }
  function status() {
    message((config.enabled ? 'ON' : 'OFF') + ' | definition ' + (supported ? 'v4' : 'unsupported') +
      ' | cache ' + cache.size + ' lists / ' + (cachedBytes / 1024).toFixed(1) + ' KiB' +
      ' | pending ' + (active ? active.chunks.length + ' parts / ' + active.bytes + ' bytes' : 'none'));
    message('Received ' + stats.received + ' / ' + (stats.receivedBytes / 1024).toFixed(1) +
      ' KiB | suppressed ' + stats.suppressed + ' | replayed ' + stats.replayed +
      ' | net saved ' + Math.max(0, stats.suppressedBytes - stats.replayedBytes) + ' bytes');
    message('Passed ' + stats.passed + ' / ' + (stats.passedBytes / 1024).toFixed(1) + ' KiB | evicted ' + stats.evicted +
      ' | timeout ' + stats.timedOut + ' | oversized ' + stats.oversized + ' | malformed ' + stats.malformed +
      ' | orphan ' + stats.orphaned + ' | replay errors ' + stats.replayFailures);
    message('Measure ' + (config.measure ? 'ON' : 'OFF') + ' | samples ' + stats.measured +
      ' | avg ' + (stats.measured ? stats.processingNs / stats.measured / 1000 : 0).toFixed(2) +
      ' us | peak ' + (stats.peakNs / 1000).toFixed(2) + ' us | elapsed ' + Math.round((Date.now() - stats.since) / 1000) + 's');
  }
  mod.command.add('cache', (command = 'status', value) => {
    try {
      command = command.toLowerCase();
      if (command === 'status') return status();
      if (command === 'on' || command === 'off') {
        const next = Object.assign({}, config, { enabled: command === 'on' }); save(next);
        reset(true); config = next; stats = counters(); message(command.toUpperCase() + '; settings saved.'); return;
      }
      if (command === 'measure' && (value === 'on' || value === 'off')) {
        const next = Object.assign({}, config, { measure: value === 'on' }); save(next); config = next;
        message('Measure ' + value.toUpperCase() + '; settings saved.'); return;
      }
      if (command === 'reset') { reset(true); message('Cache cleared.'); return; }
      if (command === 'stats' && value === 'reset') { abandon(true); stats = counters(); message('Counters cleared.'); return; }
      if (command === 'reload') { const next = readConfig(false); reset(true); config = next; message('Settings reloaded.'); return; }
      message('cache on/off/status/reset | cache stats reset | cache measure on/off | cache reload');
    } catch (error) { message('Settings unchanged: ' + error.message); }
  });
  this.destructor = () => {
    if (closed) return;
    reset(true); closed = true; player = null; mod.command.remove('cache');
    for (const value of hooks) mod.unhook(value);
  };
};
