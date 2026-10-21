'use strict';
// The extension's own requests to the host: {type:'call', reqId, method, params}, answered with
// {type:'reply', reqId, ok, result | error, code}. Only EXTENSION_METHODS are reachable this way
// (never generate, diagnose or set_config). Image data comes first in {type:'call_chunk', reqId,
// seq, total, data} pieces, like ref_chunk the other way. Pure: the host passes its handlers.
const { EXTENSION_METHODS } = require('./collections');

const MAX_REPLY = 1000000; // bytes; Chrome drops host->extension messages over 1 MB
const callError = (message, code) => Object.assign(new Error(message), { code });

// Collects call_chunk pieces per reqId. Pieces over maxChars in total, or with a bad seq, spoil the
// call (it is answered with an error); calls whose "call" never comes are dropped after ttlMs. At
// most maxPending calls collect data at a time; a call beyond that is spoiled from its first piece.
function callAssembler(maxChars, ttlMs = 120000, now = Date.now, maxPending = 4) {
  const calls = new Map(); // reqId -> { parts, total, size, at, bad }
  return {
    chunk(msg) {
      for (const [id, c] of calls) if (now() - c.at > ttlMs) calls.delete(id);
      const busy = !calls.has(msg.reqId) && [...calls.values()].filter(c => !c.bad).length >= maxPending;
      const c = calls.get(msg.reqId) || { parts: [], total: Number(msg.total) || 0, size: 0, at: now(), bad: false };
      const data = typeof msg.data === 'string' ? msg.data : '';
      c.size += data.length;
      if (busy || c.size > maxChars || !Number.isInteger(msg.seq) || msg.seq < 0 || msg.seq >= c.total) Object.assign(c, { bad: true, parts: [] });
      if (!c.bad) c.parts[msg.seq] = data;
      calls.set(msg.reqId, c);
    },
    // The pieces of one call (null when it had none); they are forgotten either way.
    take(reqId) {
      const c = calls.get(reqId) || null;
      calls.delete(reqId);
      return c;
    },
    get pending() { return calls.size; },
  };
}

async function answerCall(msg, handlers, pieces, maxMb) {
  let reply;
  try {
    if (!EXTENSION_METHODS.has(msg.method) || typeof handlers[msg.method] !== 'function') {
      throw callError(`The extension may not call "${msg.method}".`, 'NOT_ALLOWED');
    }
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? { ...msg.params } : {};
    if (pieces) {
      if (pieces.bad) throw callError(`The image is larger than ${maxMb} MB or its pieces were malformed.`, 'TOO_LARGE');
      for (let i = 0; i < pieces.total; i++) if (typeof pieces.parts[i] !== 'string') throw callError('The image did not arrive completely; please try again.', 'TRANSFER');
      params.data = pieces.parts.join('');
    }
    reply = { type: 'reply', reqId: msg.reqId, ok: true, result: await handlers[msg.method](params) };
  } catch (e) {
    reply = { type: 'reply', reqId: msg.reqId, ok: false, error: e.message, code: e.code || 'ERROR' };
  }
  if (Buffer.byteLength(JSON.stringify(reply)) > MAX_REPLY) {
    reply = { type: 'reply', reqId: msg.reqId, ok: false, error: 'The answer is too large for Chrome (over 1 MB).', code: 'TOO_LARGE' };
  }
  return reply;
}

module.exports = { MAX_REPLY, callAssembler, answerCall };
