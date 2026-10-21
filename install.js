'use strict';
// Installs Backdraw for the current user (no admin rights needed). Windows only for now; the
// OS-specific steps live in platform/.
//   node install.js              install or update; migrates an older chatgpt-image-bridge install
//   node install.js --desktop    add Backdraw to the Claude desktop app's chat config (quit Claude first)
//   node install.js --uninstall  remove the Chrome host registration and the MCP entries
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const identity = require('./identity');
const platform = require('./platform');

const { LEGACY } = identity;
const SRC = __dirname;
const FILES = ['package.json', 'LICENSE', 'identity.js', 'shared.js', 'host.js', 'mcp-server.js', 'cli.js', 'install.js', 'README.md', 'extension', 'platform', 'lib'];
const NODE = process.execPath;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

function extensionId(manifest) {
  const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Copies the settings and job history of an older install. Never overwrites; returns a report.
function migrateData(fromDir, toDir) {
  const report = [];
  for (const name of ['config.json', 'jobs.json']) {
    const from = path.join(fromDir, 'data', name);
    const to = path.join(toDir, 'data', name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) { report.push(`kept the existing ${to} (did not overwrite it with ${from})`); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    report.push(`copied ${from} -> ${to}`);
  }
  return report;
}

// Folders a config without them gets; the user's own settings are kept. pictures() is only asked
// when needed (it starts PowerShell).
function configDefaults(cfg, pictures) {
  const out = { ...cfg };
  if (!out.outputDir) out.outputDir = path.join(pictures(), identity.IMAGES_DIR_NAME);
  if (!out.collectionsDir) out.collectionsDir = path.join(pictures(), identity.IMAGES_DIR_NAME, identity.COLLECTIONS_DIR_NAME);
  return out;
}

// ---------------------------------------------------------------- Claude Code

function removeLegacyMcpFromFile(file) {
  const json = readJson(file, null);
  if (!json || !json.mcpServers || !(LEGACY.MCP_NAME in json.mcpServers)) return false;
  delete json.mcpServers[LEGACY.MCP_NAME];
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return true;
}

// Returns [where Backdraw was registered, whether the old entry was removed].
function registerMcp(serverPath) {
  const entry = { type: 'stdio', command: NODE, args: [serverPath], env: {} };
  const cli = platform.claudeCli();
  if (cli) {
    let legacyRemoved = false;
    try { execFileSync(cli, ['mcp', 'remove', LEGACY.MCP_NAME, '-s', 'user'], { stdio: 'ignore' }); legacyRemoved = true; } catch {}
    try { execFileSync(cli, ['mcp', 'remove', identity.MCP_NAME, '-s', 'user'], { stdio: 'ignore' }); } catch {}
    execFileSync(cli, ['mcp', 'add-json', identity.MCP_NAME, JSON.stringify(entry), '-s', 'user'], { stdio: 'ignore' });
    return [`"${identity.MCP_NAME}" (claude mcp, user scope)`, legacyRemoved];
  }
  const file = platform.claudeConfigFile();
  const legacyRemoved = removeLegacyMcpFromFile(file);
  const json = readJson(file, {});
  json.mcpServers = { ...(json.mcpServers || {}), [identity.MCP_NAME]: entry };
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return [`"${identity.MCP_NAME}" (${file})`, legacyRemoved];
}

function unregisterMcp() {
  const cli = platform.claudeCli();
  for (const name of [identity.MCP_NAME, LEGACY.MCP_NAME]) {
    if (cli) { try { execFileSync(cli, ['mcp', 'remove', name, '-s', 'user'], { stdio: 'ignore' }); } catch {} }
  }
  if (!cli) {
    const file = platform.claudeConfigFile();
    const json = readJson(file, null);
    if (json && json.mcpServers && (identity.MCP_NAME in json.mcpServers || LEGACY.MCP_NAME in json.mcpServers)) {
      delete json.mcpServers[identity.MCP_NAME];
      delete json.mcpServers[LEGACY.MCP_NAME];
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
    }
  }
}

// ---------------------------------------------------------------- Claude desktop app (chat)

const desktopEntry = serverPath => ({ command: NODE, args: [serverPath] });

function desktopServers(file, entry, remove) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = json.mcpServers || {};
  const servers = { ...before };
  delete servers[LEGACY.MCP_NAME];
  if (remove) delete servers[identity.MCP_NAME];
  else servers[identity.MCP_NAME] = entry;
  return { json, servers, changed: JSON.stringify(servers) !== JSON.stringify(before) };
}

// Drops the old entry and adds Backdraw (or, with remove, drops both) in one desktop config file.
// A timestamped .bak copy is written first. Returns the backup path, or null if nothing changed.
// Throws on unreadable JSON without touching the file.
function updateDesktopConfig(file, entry, { remove = false } = {}) {
  const { json, servers, changed } = desktopServers(file, entry, remove);
  if (!changed) return null;
  const backup = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, backup);
  json.mcpServers = servers;
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return backup;
}

function desktopNeedsUpdate(file, entry, remove = false) {
  try { return desktopServers(file, entry, remove).changed; } catch { return false; }
}

function desktopCommand(dest, flag) {
  return `node "${path.join(dest, 'install.js')}" ${flag}`;
}

function desktop() {
  const dest = platform.installDir();
  const server = path.join(dest, 'mcp-server.js');
  if (!fs.existsSync(server)) throw new Error(`Backdraw is not installed in ${dest} yet; run node install.js first.`);
  const files = platform.desktopConfigFiles();
  if (!files.length) return console.log('No Claude desktop app config was found; nothing to change.');
  const running = platform.desktopAppRunning();
  if (running !== false) {
    console.log(`${running === null
      ? 'Could not tell whether the Claude desktop app is running (PowerShell failed), so its config was not changed.'
      : 'The Claude desktop app is running, so its config was not changed (Claude rewrites it on exit).'}
Quit Claude completely (also from the system tray), then run this from PowerShell:
  ${desktopCommand(dest, '--desktop')}`);
    process.exitCode = 1;
    return;
  }
  for (const file of files) {
    try {
      const backup = updateDesktopConfig(file, desktopEntry(server));
      console.log(backup ? `Updated ${file}\n  backup: ${backup}` : `Already up to date: ${file}`);
    } catch (e) {
      console.log(`Skipped ${file}: ${e.message}`);
    }
  }
  console.log(`"${identity.MCP_NAME}" is available in new Claude desktop chats after Claude starts again.`);
}

// ---------------------------------------------------------------- install / uninstall

async function reloadRunningExtension(dest) {
  try {
    const shared = require(path.join(dest, 'shared.js'));
    await shared.call('reload_extension', {}, 3000);
    return true;
  } catch { return false; }
}

// What to do about the Chrome extension after the files were copied. An unpacked extension is
// read from disk when Chrome starts or when it is turned on, so a running one only needs a reload;
// one that can't be reached is either not running or (after a migration) still in the old folder.
function extensionSteps({ dest, legacyDir, hasLegacy, wasInstalled, reloaded }) {
  const folder = path.join(dest, 'extension');
  const check = `node "${path.join(dest, 'cli.js')}" status`;
  if (reloaded) {
    return ['\nThe running extension was reloaded with the new version.',
      ...(hasLegacy ? [`The old folder ${legacyDir} is no longer used; delete it by hand once Backdraw works.`] : [])];
  }
  if (hasLegacy) {
    return [`
The Chrome extension could not be reached. Either:
  - Chrome is closed or Backdraw is turned off: open Chrome, or turn Backdraw on at chrome://extensions; it connects by itself.
  - Or it is still loaded from the old folder ${path.join(legacyDir, 'extension')}: at chrome://extensions remove the old
    "Claude ChatGPT Görsel Köprüsü" extension, click "Load unpacked" and select ${folder}
Check the connection: ${check}
Once Backdraw works, delete the old folder by hand: ${legacyDir}`];
  }
  if (wasInstalled) {
    return [`
The Chrome extension could not be reached (Chrome is closed or Backdraw is turned off).
Chrome loads the new files when it starts, or when Backdraw is turned on at chrome://extensions.
Check the connection: ${check}
If it was never loaded: open chrome://extensions, turn on "Developer mode", click "Load unpacked" and select ${folder}`];
  }
  return [`
Load the Chrome extension once:
  1) Open chrome://extensions in Chrome and turn on "Developer mode" (top right).
  2) Click "Load unpacked" and select this folder:
     ${folder}`];
}

async function install() {
  const dest = platform.installDir();
  const legacyDir = platform.legacyInstallDir();
  const hasLegacy = fs.existsSync(legacyDir) && !samePath(legacyDir, dest);
  const wasInstalled = fs.existsSync(path.join(dest, 'extension', 'manifest.json'));
  if (!samePath(SRC, dest)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of FILES) {
      if (fs.existsSync(path.join(SRC, f))) fs.cpSync(path.join(SRC, f), path.join(dest, f), { recursive: true, force: true });
    }
  }
  const migration = hasLegacy ? migrateData(legacyDir, dest) : [];
  const id = extensionId(readJson(path.join(dest, 'extension', 'manifest.json'), {}));

  // Chrome starts this host when the extension connects (native messaging).
  const launcher = platform.writeHostLauncher(dest, NODE);
  const hostManifest = path.join(dest, `${identity.HOST_NAME}.json`);
  fs.writeFileSync(hostManifest, JSON.stringify({
    name: identity.HOST_NAME, description: identity.HOST_DESCRIPTION, path: launcher, type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
  platform.unregisterNativeHost(LEGACY.HOST_NAME);
  const hostEntry = platform.registerNativeHost(identity.HOST_NAME, hostManifest);

  const cfgFile = path.join(dest, 'data', 'config.json');
  let pictures = null;
  const cfg = configDefaults(readJson(cfgFile, {}), () => pictures || (pictures = platform.picturesDir()));
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  const server = path.join(dest, 'mcp-server.js');
  const [mcp, legacyMcpRemoved] = registerMcp(server);
  const reloaded = await reloadRunningExtension(dest);

  const lines = [`Install complete.
  Folder            : ${dest}
  Chrome host entry : ${hostEntry}
  Claude Code MCP   : ${mcp}
  Images folder     : ${cfg.outputDir}
  Collections folder: ${cfg.collectionsDir}
  Extension ID      : ${id}`];
  if (hasLegacy) {
    lines.push(`\nMigrated from the old install in ${legacyDir}:`,
      ...(migration.length ? migration.map(m => `  - ${m}`) : ['  - no settings or job history to copy']),
      `  - removed the old Chrome host entry (${LEGACY.HOST_NAME}), if it was there`,
      `  - ${legacyMcpRemoved ? 'removed' : 'no'} old "${LEGACY.MCP_NAME}" Claude Code MCP entry`);
  }
  lines.push(...extensionSteps({ dest, legacyDir, hasLegacy, wasInstalled, reloaded }));
  const staleDesktop = platform.desktopConfigFiles().filter(f => desktopNeedsUpdate(f, desktopEntry(server)));
  if (staleDesktop.length) {
    const running = platform.desktopAppRunning();
    lines.push(`
Claude desktop app: its chat config does not use Backdraw yet. ${running === false
    ? 'To update it, run:'
    : `${running ? 'Claude is running' : 'Could not tell whether Claude is running'}, so it was left alone. Quit Claude completely (also from the system tray), then run this from PowerShell:`}
  ${desktopCommand(dest, '--desktop')}`);
  }
  lines.push(`The "${identity.MCP_NAME}" tools are ready in new Claude Code sessions.`);
  console.log(lines.join('\n'));
}

function uninstall() {
  const dest = platform.installDir();
  const legacyDir = platform.legacyInstallDir();
  for (const name of [identity.HOST_NAME, LEGACY.HOST_NAME]) platform.unregisterNativeHost(name);
  unregisterMcp();
  const lines = [`Removed: the Chrome host entries (${identity.HOST_NAME}, ${LEGACY.HOST_NAME}) and the Claude Code MCP entries ("${identity.MCP_NAME}", "${LEGACY.MCP_NAME}").`];

  const desktopFiles = platform.desktopConfigFiles().filter(f => desktopNeedsUpdate(f, null, true));
  const desktopRunning = desktopFiles.length ? platform.desktopAppRunning() : false;
  if (desktopRunning !== false) {
    lines.push(`${desktopRunning ? 'The Claude desktop app is running' : 'Could not tell whether the Claude desktop app is running'}, so its chat config was left alone. Quit Claude completely, then run this again from PowerShell:
  ${desktopCommand(fs.existsSync(path.join(dest, 'install.js')) ? dest : SRC, '--uninstall')}`);
  } else {
    for (const file of desktopFiles) {
      try { lines.push(`Updated ${file} (backup: ${updateDesktopConfig(file, null, { remove: true })})`); } catch (e) { lines.push(`Skipped ${file}: ${e.message}`); }
    }
  }
  const folders = [dest, legacyDir].filter(d => fs.existsSync(d));
  lines.push(`Remaining steps: remove the extension at chrome://extensions${folders.length ? `; optionally delete ${folders.join(' and ')}` : ''} (your images are kept in a separate folder).`);
  console.log(lines.join('\n'));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const run = args.includes('--uninstall') ? uninstall : args.includes('--desktop') ? desktop : install;
  Promise.resolve().then(run).catch(e => { console.error(`Setup failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = { FILES, migrateData, updateDesktopConfig, desktopEntry, extensionSteps, configDefaults };
