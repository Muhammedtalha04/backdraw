'use strict';
// Installs the bridge for the current user (no admin rights needed). Windows only for now; the
// OS-specific steps live in platform/.
//   node install.js              install or update
//   node install.js --uninstall  remove the Chrome host registration and the Claude Code MCP entry
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const platform = require('./platform');

const HOST_NAME = 'com.claude.chatgpt_image_bridge';
const MCP_NAME = 'chatgpt-images';
const SRC = __dirname;
const DEST = platform.installDir();
const FILES = ['package.json', 'LICENSE', 'shared.js', 'host.js', 'mcp-server.js', 'cli.js', 'install.js', 'README.md', 'extension', 'platform'];
const NODE = process.execPath;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function extensionId(manifest) {
  const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function registerMcp(serverPath) {
  const entry = { type: 'stdio', command: NODE, args: [serverPath], env: {} };
  const cli = platform.claudeCli();
  if (cli) {
    try { execFileSync(cli, ['mcp', 'remove', MCP_NAME, '-s', 'user'], { stdio: 'ignore' }); } catch {}
    execFileSync(cli, ['mcp', 'add-json', MCP_NAME, JSON.stringify(entry), '-s', 'user'], { stdio: 'ignore' });
    return `"${MCP_NAME}" (claude mcp, user scope)`;
  }
  const file = platform.claudeConfigFile();
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
  const launcher = platform.writeHostLauncher(DEST, NODE);
  const hostManifest = path.join(DEST, `${HOST_NAME}.json`);
  fs.writeFileSync(hostManifest, JSON.stringify({
    name: HOST_NAME, description: 'Claude ChatGPT image bridge', path: launcher, type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
  const hostEntry = platform.registerNativeHost(HOST_NAME, hostManifest);

  const cfgFile = path.join(DEST, 'data', 'config.json');
  const cfg = readJson(cfgFile, {});
  if (!cfg.outputDir) cfg.outputDir = path.join(platform.picturesDir(), 'ChatGPT Görselleri');
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  const mcp = registerMcp(path.join(DEST, 'mcp-server.js'));
  const reloaded = await reloadRunningExtension();

  console.log(`Install complete.
  Folder            : ${DEST}
  Chrome host entry : ${hostEntry}
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
  platform.unregisterNativeHost(HOST_NAME);
  const cli = platform.claudeCli();
  if (cli) { try { execFileSync(cli, ['mcp', 'remove', MCP_NAME, '-s', 'user'], { stdio: 'ignore' }); } catch {} }
  console.log(`Removed: the Chrome host entry and the Claude Code MCP entry.
Remaining steps: remove the extension at chrome://extensions; optionally delete ${DEST} (your images are kept in a separate folder).`);
}

if (process.argv.includes('--uninstall')) uninstall();
else install().catch(e => { console.error(`Install failed: ${e.message}`); process.exitCode = 1; });
