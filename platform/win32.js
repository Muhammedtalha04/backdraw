'use strict';
// Windows implementation: named pipe, Chrome native host registration (registry), user folders,
// and where the Claude Code CLI, the Claude desktop app and their configs live.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const identity = require('../identity');

const USER_TAG = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');

function pipePath() {
  return `\\\\.\\pipe\\${identity.PIPE_PREFIX}-${USER_TAG}`;
}

// In the home folder, not under AppData: the Claude desktop app is an MSIX package, and AppData
// writes made from its processes are redirected into the package's private storage, where Chrome
// can't see them. The home folder itself is not redirected.
function installDir() {
  return path.join(os.homedir(), identity.INSTALL_DIR_NAME);
}

function legacyInstallDir() {
  return path.join(os.homedir(), ...identity.LEGACY.INSTALL_DIR);
}

function claudeConfigFile() {
  return path.join(os.homedir(), '.claude.json');
}

// Chat MCP config of the Claude desktop app: the MSIX package's private copy and the classic one.
function desktopConfigFiles() {
  const files = [];
  const packages = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  try {
    for (const dir of fs.readdirSync(packages)) {
      if (/^Claude_/i.test(dir)) files.push(path.join(packages, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  } catch {}
  files.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'));
  return files.filter(f => fs.existsSync(f));
}

// True while the Claude desktop app runs (it rewrites its config on exit). Claude Code's own
// claude.exe has the same process name but lives elsewhere; a process whose path can't be read
// counts as running, to be safe.
function desktopAppRunning() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $_.Path } else { '?' } }"],
  { encoding: 'utf8' });
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .some(p => p === '?' || /\\WindowsApps\\|\\AnthropicClaude\\/i.test(p));
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
$r = Reg 'SetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = ''; sValue = $env:BACKDRAW_VALUE }
if ($r.ReturnValue -ne 0) { throw "SetStringValue returned $($r.ReturnValue)" }
(Reg 'GetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = '' }).sValue`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', env: { ...process.env, BACKDRAW_VALUE: value } }).trim();
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
  pipePath, installDir, legacyInstallDir, claudeConfigFile, desktopConfigFiles, desktopAppRunning,
  writeHostLauncher, registerNativeHost, unregisterNativeHost,
  picturesDir, claudeCli,
};
