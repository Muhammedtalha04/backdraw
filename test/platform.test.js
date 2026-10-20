'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PLATFORM_DIR = path.join(__dirname, '..', 'platform');

function loadFor(platformName) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platformName });
  try {
    for (const key of Object.keys(require.cache)) if (key.startsWith(PLATFORM_DIR)) delete require.cache[key];
    return require(PLATFORM_DIR);
  } finally {
    Object.defineProperty(process, 'platform', original);
    for (const key of Object.keys(require.cache)) if (key.startsWith(PLATFORM_DIR)) delete require.cache[key];
  }
}

test('Windows pipe path and install folder keep their names', () => {
  const win = loadFor('win32');
  const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
  assert.equal(win.pipePath(), String.raw`\\.\pipe\chatgpt-image-bridge-` + user);
  assert.equal(win.installDir(), path.join(os.homedir(), '.claude', 'chatgpt-image-bridge'));
});

test('other platforms get a clear "not supported yet" error', () => {
  const other = loadFor('darwin');
  const win = loadFor('win32');
  assert.deepEqual(Object.keys(other).sort(), Object.keys(win).sort());
  for (const fn of Object.values(other)) assert.throws(() => fn(), /"darwin" is not supported yet/);
});
