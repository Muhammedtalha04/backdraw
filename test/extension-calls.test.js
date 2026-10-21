'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_REPLY, callAssembler, answerCall } = require('../lib/extension-calls');

const chunks = (data, size) => Array.from({ length: Math.max(1, Math.ceil(data.length / size)) }, (_, seq) => ({ seq, data: data.slice(seq * size, (seq + 1) * size) }));
const feed = (calls, reqId, data, size = 4, extra = {}) => {
  const list = chunks(data, size);
  for (const c of list) calls.chunk({ type: 'call_chunk', reqId, total: list.length, ...c, ...extra });
};

test('calls reach only the collection methods, whatever handlers the host has', async () => {
  const ran = [];
  const handlers = {};
  for (const m of ['generate', 'diagnose', 'set_config', 'select_project', 'reload_extension', 'cancel', 'status', 'list_collections']) {
    handlers[m] = () => { ran.push(m); return 'ran'; };
  }
  for (const method of ['generate', 'diagnose', 'set_config', 'select_project', 'reload_extension', 'cancel', 'status', '__proto__', 'constructor', 'toString', undefined]) {
    const r = await answerCall({ reqId: 'r1', method, params: {} }, handlers, null, 25);
    assert.deepEqual(r, { type: 'reply', reqId: 'r1', ok: false, error: `The extension may not call "${method}".`, code: 'NOT_ALLOWED' }, String(method));
  }
  assert.deepEqual(ran, []);
  assert.deepEqual(await answerCall({ reqId: 'r2', method: 'list_collections' }, handlers, null, 25), { type: 'reply', reqId: 'r2', ok: true, result: 'ran' });
  // An allowed method the host doesn't answer is refused too.
  assert.equal((await answerCall({ reqId: 'r3', method: 'collection_thumbs' }, handlers, null, 25)).code, 'NOT_ALLOWED');
});

test('handler errors come back as replies with their code', async () => {
  const handlers = { rename_collection: () => { throw Object.assign(new Error('A collection named "x" already exists.'), { code: 'EXISTS' }); } };
  assert.deepEqual(await answerCall({ reqId: 'a', method: 'rename_collection', params: { name: 'y', newName: 'x' } }, handlers, null, 25),
    { type: 'reply', reqId: 'a', ok: false, error: 'A collection named "x" already exists.', code: 'EXISTS' });
  const plain = { delete_collection: async () => { throw new Error('boom'); } };
  assert.equal((await answerCall({ reqId: 'b', method: 'delete_collection' }, plain, null, 25)).code, 'ERROR');
});

test('chunked data is put back together as params.data; the extension cannot pass a second copy', async () => {
  const calls = callAssembler(1000);
  let got = null;
  const handlers = { collection_add: p => { got = p; return { ok: 1 }; } };
  feed(calls, 'c1', 'iVBORw0KGgoAAAANSUhEUg', 5);
  assert.equal(calls.pending, 1);
  const r = await answerCall({ reqId: 'c1', method: 'collection_add', params: { collection: 'x', data: 'ignored' } }, handlers, calls.take('c1'), 25);
  assert.equal(r.ok, true);
  assert.deepEqual(got, { collection: 'x', data: 'iVBORw0KGgoAAAANSUhEUg' });
  assert.equal(calls.pending, 0);
  assert.equal(calls.take('c1'), null);
});

test('pieces out of order are fine; a missing piece is reported', async () => {
  const calls = callAssembler(1000);
  const handlers = { collection_add: p => p.data };
  const list = chunks('abcdefghij', 3);
  for (const c of [...list].reverse()) calls.chunk({ reqId: 'o', total: list.length, ...c });
  assert.equal((await answerCall({ reqId: 'o', method: 'collection_add' }, handlers, calls.take('o'), 25)).result, 'abcdefghij');
  for (const c of list.filter(c => c.seq !== 1)) calls.chunk({ reqId: 'm', total: list.length, ...c });
  assert.equal((await answerCall({ reqId: 'm', method: 'collection_add' }, handlers, calls.take('m'), 25)).code, 'TRANSFER');
});

test('too much data or malformed pieces spoil the call, and the pieces are dropped', async () => {
  const handlers = { collection_add: () => 'saved' };
  const big = callAssembler(10);
  feed(big, 'b', 'x'.repeat(11), 4);
  const spoiled = big.take('b');
  assert.equal(spoiled.bad, true);
  assert.deepEqual(spoiled.parts, []);
  const r = await answerCall({ reqId: 'b', method: 'collection_add' }, handlers, spoiled, 25);
  assert.deepEqual(r, { type: 'reply', reqId: 'b', ok: false, error: 'The image is larger than 25 MB or its pieces were malformed.', code: 'TOO_LARGE' });
  for (const bad of [{ seq: 5, total: 2 }, { seq: -1, total: 2 }, { seq: 0.5, total: 2 }, { seq: '0', total: 2 }, { seq: 0, total: 0 }, { seq: 0, total: 'x' }]) {
    const calls = callAssembler(100);
    calls.chunk({ reqId: 'q', data: 'abc', ...bad });
    assert.equal(calls.take('q').bad, true, JSON.stringify(bad));
  }
  const odd = callAssembler(100);
  odd.chunk({ reqId: 'n', seq: 0, total: 1, data: { not: 'a string' } });
  assert.equal((await answerCall({ reqId: 'n', method: 'collection_add' }, { collection_add: p => p.data }, odd.take('n'), 25)).result, '');
});

test('pieces of a call that never comes are forgotten after a while', () => {
  let t = 0;
  const calls = callAssembler(100, 1000, () => t);
  calls.chunk({ reqId: 'old', seq: 0, total: 2, data: 'ab' });
  t = 1500;
  calls.chunk({ reqId: 'new', seq: 0, total: 1, data: 'cd' });
  assert.equal(calls.pending, 1);
  assert.equal(calls.take('old'), null);
});

test('a reply over 1 MB is replaced by an error (Chrome would drop it)', async () => {
  const handlers = { collection_thumbs: () => ({ thumbs: [{ data: 'x'.repeat(MAX_REPLY) }] }) };
  const r = await answerCall({ reqId: 't', method: 'collection_thumbs' }, handlers, null, 25);
  assert.deepEqual(r, { type: 'reply', reqId: 't', ok: false, error: 'The answer is too large for Chrome (over 1 MB).', code: 'TOO_LARGE' });
  assert.ok(MAX_REPLY <= 1024 * 1024);
});

test('params that are not an object become empty', async () => {
  const handlers = { list_collections: p => p };
  for (const params of [null, 'x', 5, ['a']]) {
    assert.deepEqual((await answerCall({ reqId: 'p', method: 'list_collections', params }, handlers, null, 25)).result, {});
  }
});
