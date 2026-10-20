'use strict';
// The extension can't read package.json at runtime, so its manifest version is kept in sync by hand.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

test('extension manifest version matches package.json', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const manifest = require(path.join(ROOT, 'extension', 'manifest.json'));
  assert.equal(manifest.version, pkg.version);
});

test('host and MCP server report the package.json version', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  assert.equal(require(path.join(ROOT, 'shared.js')).VERSION, pkg.version);
});
