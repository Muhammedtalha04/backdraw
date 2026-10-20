'use strict';
// Installs the bridge for the current Windows user (no admin rights needed).
//   node install.js              install or update
//   node install.js --uninstall  remove the Chrome host registration and the Claude Code MCP entry
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.claude.chatgpt_image_bridge';
const MCP_NAME = 'chatgpt-images';
const SRC = __dirname;
// Not under AppData: the Claude desktop app is an MSIX package, and AppData writes made from its
// processes are redirected into the package's private storage, where Chrome can't see them.
const DEST = path.join(os.homedir(), '.claude', 'chatgpt-image-bridge');
const REG_SUBKEY = `Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const REG_KEY = `HKCU\\${REG_SUBKEY}`;
const FILES = ['package.json', 'LICENSE', 'shared.js', 'host.js', 'mcp-server.js', 'cli.js', 'install.js', 'README.md', 'extension'];
const NODE = process.execPath;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Same MSIX caveat for the registry: HKCU writes from inside the package go to a private copy.
// WMI's registry provider runs outside the package, so it writes the HKCU that Chrome reads.
function realRegistry(action, value = '') {
  const ps = `$ErrorActionPreference = 'Stop'
$hk = [uint32]2147483649
$k = '${REG_SUBKEY}'
function Reg($m, $a) { Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName $m -Arguments $a }
if ('${action}' -eq 'delete') { [void](Reg 'DeleteKey' @{ hDefKey = $hk; sSubKeyName = $k }); exit }
[void](Reg 'CreateKey' @{ hDefKey = $hk; sSubKeyName = $k })
$r = Reg 'SetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = ''; sValue = $env:CGB_VALUE }
if ($r.ReturnValue -ne 0) { throw "SetStringValue returned $($r.ReturnValue)" }
(Reg 'GetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = '' }).sValue`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', env: { ...process.env, CGB_VALUE: value } }).trim();
}

function registerHost(manifestPath) {
  try { execFileSync('reg.exe', ['delete', REG_KEY, '/f'], { stdio: 'ignore' }); } catch {} // stale private copy, if any
  try {
    if (realRegistry('set', manifestPath) === manifestPath) return;
  } catch {}
  execFileSync('reg.exe', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
}

function extensionId(manifest) {
  const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
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

function registerMcp(serverPath) {
  const entry = { type: 'stdio', command: NODE, args: [serverPath], env: {} };
  const cli = claudeCli();
  if (cli) {
    try { execFileSync(cli, ['mcp', 'remove', MCP_NAME, '-s', 'user'], { stdio: 'ignore' }); } catch {}
    execFileSync(cli, ['mcp', 'add-json', MCP_NAME, JSON.stringify(entry), '-s', 'user'], { stdio: 'ignore' });
    return `"${MCP_NAME}" (claude mcp, user scope)`;
  }
  const file = path.join(os.homedir(), '.claude.json');
  const json = readJson(file, {});
  json.mcpServers = { ...(json.mcpServers || {}), [MCP_NAME]: entry };
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return `"${MCP_NAME}" (${file})`;
}

async function reloadRunningExtension() {
  try {
    const shared = require(path.join(DEST, 'shared.js'));
    await shared.call('reload_extension', {}, 3000);
    return true;
  } catch { return false; }
}

async function install() {
  if (path.resolve(SRC).toLowerCase() !== path.resolve(DEST).toLowerCase()) {
    fs.mkdirSync(DEST, { recursive: true });
    for (const f of FILES) {
      if (fs.existsSync(path.join(SRC, f))) fs.cpSync(path.join(SRC, f), path.join(DEST, f), { recursive: true, force: true });
    }
  }
  const id = extensionId(readJson(path.join(DEST, 'extension', 'manifest.json'), {}));

  // Chrome starts this host when the extension connects (native messaging).
  const bat = path.join(DEST, 'host.bat');
  fs.writeFileSync(bat, `@echo off\r\n"${NODE}" "%~dp0host.js" %*\r\n`);
  const hostManifest = path.join(DEST, `${HOST_NAME}.json`);
  fs.writeFileSync(hostManifest, JSON.stringify({
    name: HOST_NAME, description: 'Claude ChatGPT image bridge', path: bat, type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
  registerHost(hostManifest);

  const cfgFile = path.join(DEST, 'data', 'config.json');
  const cfg = readJson(cfgFile, {});
  if (!cfg.outputDir) cfg.outputDir = path.join(picturesDir(), 'ChatGPT Görselleri');
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  const mcp = registerMcp(path.join(DEST, 'mcp-server.js'));
  const reloaded = await reloadRunningExtension();

  console.log(`Install complete.
  Folder            : ${DEST}
  Chrome host entry : ${REG_KEY}
  Claude Code MCP   : ${mcp}
  Images folder     : ${cfg.outputDir}
  Extension ID      : ${id}
${reloaded ? '\nThe running extension was reloaded with the new version.' : `
Load the Chrome extension once:
  1) Open chrome://extensions in Chrome and turn on "Developer mode" (top right).
  2) Click "Load unpacked" and select this folder:
     ${path.join(DEST, 'extension')}`}
The "chatgpt-images" tools are ready in new Claude Code sessions.`);
}

function uninstall() {
  try { realRegistry('delete'); } catch {}
  try { execFileSync('reg.exe', ['delete', REG_KEY, '/f'], { stdio: 'ignore' }); } catch {}
  const cli = claudeCli();
  if (cli) { try { execFileSync(cli, ['mcp', 'remove', MCP_NAME, '-s', 'user'], { stdio: 'ignore' }); } catch {} }
  console.log(`Removed: the Chrome host entry and the Claude Code MCP entry.
Remaining steps: remove the extension at chrome://extensions; optionally delete ${DEST} (your images are kept in a separate folder).`);
}

if (process.argv.includes('--uninstall')) uninstall();
else install().catch(e => { console.error(`Install failed: ${e.message}`); process.exitCode = 1; });
