'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const identity = require('../identity');

const ROOT = path.join(__dirname, '..');

test('identity constants', () => {
  assert.equal(identity.PRODUCT, 'Backdraw');
  assert.equal(identity.HOST_NAME, 'io.github.muhammedtalha04.backdraw');
  assert.equal(identity.HOST_DESCRIPTION, 'Backdraw native host');
  assert.equal(identity.MCP_NAME, 'backdraw');
  assert.equal(identity.PIPE_PREFIX, 'backdraw');
  assert.equal(identity.PIPE_ENV, 'BACKDRAW_PIPE');
  assert.equal(identity.INSTALL_DIR_NAME, '.backdraw');
  assert.equal(identity.IMAGES_DIR_NAME, 'Backdraw');
  assert.equal(identity.COLLECTIONS_DIR_NAME, 'References');
  assert.equal(identity.LEGACY.HOST_NAME, 'com.claude.chatgpt_image_bridge');
  assert.equal(identity.LEGACY.MCP_NAME, 'chatgpt-images');
});

test('Chrome native host names are valid (lowercase, dots, underscores)', () => {
  assert.match(identity.HOST_NAME, /^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
});

test('the extension connects to the same native host name', () => {
  const background = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
  assert.match(background, new RegExp(`const HOST = '${identity.HOST_NAME.replace(/\./g, '\\.')}'`));
});

test('extension manifest uses the Backdraw names and keeps its key (same extension ID)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Backdraw');
  assert.equal(manifest.short_name, 'Backdraw');
  assert.equal(manifest.action.default_title, 'Backdraw');
  assert.ok(manifest.key.startsWith('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtu/jyAJ3e3hnNrNGCxfzvHLOp80L9c3j71jmQV2ymY1D'));
});

test('BACKDRAW_PIPE overrides the pipe path', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./shared').PIPE_PATH)"],
    { cwd: ROOT, env: { ...process.env, BACKDRAW_PIPE: 'test-pipe' }, encoding: 'utf8' });
  assert.equal(out, 'test-pipe');
});
