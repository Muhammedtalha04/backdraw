'use strict';
// MCP protocol revisions. Legacy clients open with an initialize handshake; modern clients
// (2026-07-28) send no handshake and name the version in params._meta of every request instead.
// The server speaks both: a request carrying the _meta version is served statelessly, an
// initialize request selects legacy semantics.

const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MODERN_VERSIONS = ['2026-07-28'];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const UNSUPPORTED_VERSION = -32022;
// The tool list never changes while the server runs, and it is the same for every user.
const CACHED = new Set(['server/discover', 'tools/list', 'prompts/list', 'resources/list']);
const CACHE = { ttlMs: 3600000, cacheScope: 'public' };

// Echo a legacy version we know; answer anything else with our newest one and let the client
// decide whether it can continue (the legacy rule).
function negotiateLegacy(requested) {
  return LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
}

// The version a modern request names, or null for a legacy request (no _meta version).
function requestVersion(params) {
  const v = params && params._meta && params._meta[VERSION_KEY];
  return v === undefined || v === null ? null : String(v);
}

function unsupportedVersion(requested) {
  return { code: UNSUPPORTED_VERSION, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_VERSIONS], requested } };
}

// Every modern result says it is complete and who answered; cacheable results also say for how long.
function modernResult(method, result, serverInfo) {
  return {
    ...result,
    ...(CACHED.has(method) ? CACHE : {}),
    resultType: 'complete',
    _meta: { ...(result && result._meta), [SERVER_INFO_KEY]: serverInfo },
  };
}

function discoverResult(serverInfo, instructions) {
  return modernResult('server/discover', { supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: {} }, instructions }, serverInfo);
}

module.exports = {
  LEGACY_VERSIONS, MODERN_VERSIONS, SUPPORTED_VERSIONS, VERSION_KEY, SERVER_INFO_KEY, UNSUPPORTED_VERSION,
  negotiateLegacy, requestVersion, unsupportedVersion, modernResult, discoverResult,
};
