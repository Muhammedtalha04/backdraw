'use strict';
// Windows implementation: named pipe, Chrome native host registration (registry), user folders,
// and where the Claude Code CLI and its config live.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const USER_TAG = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');

function pipePath() {
  return `\\\\.\\pipe\\chatgpt-image-bridge-${USER_TAG}`;
}

// Not under AppData: the Claude desktop app is an MSIX package, and AppData writes made from its
// processes are redirected into the package's private storage, where Chrome can't see them.
function installDir() {
  return path.join(os.homedir(), '.claude', 'chatgpt-image-bridge');
}

function claudeConfigFile() {
  return path.join(os.homedir(), '.claude.json');
}

const regSubkey = hostName => `Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
const regKey = hostName => `HKCU\\${regSubkey(hostName)}`;

// Same MSIX caveat for the registry: HKCU writes from inside the package go to a private copy.
// WMI's registry provider runs outside the package, so it writes the HKCU that Chrome reads.
function realRegistry(hostName, action, value = '') {
  const ps = `$ErrorActionPreference = 'Stop'
$hk = [uint32]2147483649
$k = '${regSubkey(hostName)}'
function Reg($m, $a) { Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName $m -Arguments $a }
if ('${action}' -eq 'delete') { [void](Reg 'DeleteKey' @{ hDefKey = $hk; sSubKeyName = $k }); exit }
[void](Reg 'CreateKey' @{ hDefKey = $hk; sSubKeyName = $k })
$r = Reg 'SetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = ''; sValue = $env:CGB_VALUE }
if ($r.ReturnValue -ne 0) { throw "SetStringValue returned $($r.ReturnValue)" }
(Reg 'GetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = '' }).sValue`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', env: { ...process.env, CGB_VALUE: value } }).trim();
}

// Chrome starts the host through this launcher when the extension connects (native messaging).
function writeHostLauncher(dir, nodePath) {
  const bat = path.join(dir, 'host.bat');
  fs.writeFileSync(bat, `@echo off\r\n"${nodePath}" "%~dp0host.js" %*\r\n`);
  return bat;
}

// Returns where the registration lives, for display.
function registerNativeHost(hostName, manifestPath) {
  const key = regKey(hostName);
  try { execFileSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore' }); } catch {} // stale private copy, if any
  try {
    if (realRegistry(hostName, 'set', manifestPath) === manifestPath) return key;
  } catch {}
  execFileSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  return key;
}

function unregisterNativeHost(hostName) {
  try { realRegistry(hostName, 'delete'); } catch {}
  try { execFileSync('reg.exe', ['delete', regKey(hostName), '/f'], { stdio: 'ignore' }); } catch {}
}

function picturesDir() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyPictures')"], { encoding: 'utf8' }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return path.join(os.homedir(), 'Pictures');
}

function claudeCli() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  try { return execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

module.exports = {
  pipePath, installDir, claudeConfigFile, writeHostLauncher, registerNativeHost, unregisterNativeHost,
  picturesDir, claudeCli,
};
