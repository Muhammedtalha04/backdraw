'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const protocol = require('../lib/protocol');

const SERVER_INFO = { name: 'backdraw', version: '1.0.0' };

test('known versions: legacy newest first, modern listed before legacy', () => {
  assert.deepEqual(protocol.LEGACY_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  assert.deepEqual(protocol.MODERN_VERSIONS, ['2026-07-28']);
  assert.deepEqual(protocol.SUPPORTED_VERSIONS, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
});

test('negotiateLegacy: a known legacy version is echoed', () => {
  for (const v of protocol.LEGACY_VERSIONS) assert.equal(protocol.negotiateLegacy(v), v);
});

test('negotiateLegacy: anything else gets the newest legacy version', () => {
  for (const v of ['1999-01-01', '2024-10-07', '2026-07-28', '2099-01-01', 'latest', '', '2025-6-18', 20250618, null, undefined, {}]) {
    assert.equal(protocol.negotiateLegacy(v), '2025-11-25', String(v));
  }
});

test('requestVersion: the modern _meta version, or null for a legacy request', () => {
  const meta = v => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v } });
  assert.equal(protocol.requestVersion(meta('2026-07-28')), '2026-07-28');
  assert.equal(protocol.requestVersion(meta('2099-01-01')), '2099-01-01');
  assert.equal(protocol.requestVersion(meta(20260728)), '20260728');
  assert.equal(protocol.requestVersion(meta(null)), null);
  assert.equal(protocol.requestVersion({ _meta: { progressToken: 1 } }), null);
  assert.equal(protocol.requestVersion({ protocolVersion: '2025-06-18' }), null); // initialize's own field
  assert.equal(protocol.requestVersion({}), null);
  assert.equal(protocol.requestVersion(undefined), null);
  assert.equal(protocol.requestVersion(null), null);
});

test('unsupportedVersion: the -32022 error with what is supported and what was asked', () => {
  const e = protocol.unsupportedVersion('2099-01-01');
  assert.deepEqual(e, {
    code: -32022, message: 'Unsupported protocol version',
    data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], requested: '2099-01-01' },
  });
  e.data.supported.push('x');
  assert.equal(protocol.SUPPORTED_VERSIONS.length, 5); // callers get a copy
});

test('modernResult: complete, with serverInfo; list results are cacheable', () => {
  assert.deepEqual(protocol.modernResult('tools/call', { content: [], isError: false }, SERVER_INFO), {
    content: [], isError: false, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });
  for (const method of ['tools/list', 'prompts/list', 'resources/list']) {
    const r = protocol.modernResult(method, { tools: [] }, SERVER_INFO);
    assert.equal(r.resultType, 'complete');
    assert.equal(r.ttlMs, 3600000);
    assert.equal(r.cacheScope, 'public');
  }
  const kept = protocol.modernResult('tools/call', { _meta: { other: 1 } }, SERVER_INFO);
  assert.deepEqual(kept._meta, { other: 1, 'io.modelcontextprotocol/serverInfo': SERVER_INFO });
});

test('discoverResult: versions, capabilities, instructions and caching', () => {
  assert.deepEqual(protocol.discoverResult(SERVER_INFO, 'Use it well.'), {
    supportedVersions: protocol.SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    instructions: 'Use it well.',
    ttlMs: 3600000,
    cacheScope: 'public',
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });
});
