'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const win32 = require('../platform/win32');

const DESKTOP_MSIX = String.raw`C:\Program Files\WindowsApps\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe`;
const DESKTOP_CLASSIC = String.raw`C:\Users\me\AppData\Local\AnthropicClaude\app-1.0.0\claude.exe`;
const CLAUDE_CODE = String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.299\f0584be0fbaf\claude.exe`;
const CLAUDE_CLI = String.raw`C:\Users\me\.local\bin\claude.exe`;

test('no claude process: desktop app is closed', () => {
  assert.equal(win32.parseClaudeProcesses(''), false);
  assert.equal(win32.parseClaudeProcesses('\r\n'), false);
  assert.equal(win32.parseClaudeProcesses(undefined), false);
});

test('desktop app paths (MSIX WindowsApps or classic AnthropicClaude): running', () => {
  assert.equal(win32.parseClaudeProcesses(`${DESKTOP_MSIX}\r\n`), true);
  assert.equal(win32.parseClaudeProcesses(DESKTOP_CLASSIC), true);
  assert.equal(win32.parseClaudeProcesses(`${CLAUDE_CODE}\r\n${DESKTOP_MSIX}\r\n`), true);
});

test('unreadable path counts as running, to be safe', () => {
  assert.equal(win32.parseClaudeProcesses('?\r\n'), true);
  assert.equal(win32.parseClaudeProcesses(`${CLAUDE_CLI}\r\n?`), true);
});

test('only Claude Code processes: desktop app is closed', () => {
  assert.equal(win32.parseClaudeProcesses(`${CLAUDE_CODE}\r\n${CLAUDE_CLI}\r\n`), false);
});

test('desktopAppRunning never throws: true/false normally, null when PowerShell cannot run',
  { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    assert.equal(typeof win32.desktopAppRunning(), 'boolean');
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.equal(win32.desktopAppRunning(), null);
    } finally {
      process.env.PATH = saved;
    }
  });
