'use strict';
// Runs install.js helpers on temporary files only; the real Claude configs are never touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FILES, migrateData, updateDesktopConfig, desktopEntry, extensionSteps } = require('../install');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const backups = file => fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.bak'));

test('desktop config: removes the old entry, adds backdraw, keeps everything else', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  const original = {
    mcpServers: { other: { command: 'cmd.exe', args: ['/c', 'x'] }, 'chatgpt-images': { command: 'node.exe', args: ['old.js'] } },
    preferences: { theme: 'dark' },
  };
  writeJson(file, original);
  const entry = desktopEntry('C:\\new\\mcp-server.js');

  const backup = updateDesktopConfig(file, entry);
  assert.ok(backup && fs.existsSync(backup));
  assert.deepEqual(readJson(backup), original);
  const updated = readJson(file);
  assert.deepEqual(Object.keys(updated.mcpServers).sort(), ['backdraw', 'other']);
  assert.deepEqual(updated.mcpServers.backdraw, entry);
  assert.deepEqual(updated.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(updated.preferences, original.preferences);

  // Running it again changes nothing and makes no new backup.
  assert.equal(updateDesktopConfig(file, entry), null);
  assert.equal(backups(file).length, 1);
});

test('desktop config: adds mcpServers when missing', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  writeJson(file, { preferences: {} });
  updateDesktopConfig(file, desktopEntry('C:\\new\\mcp-server.js'));
  assert.deepEqual(Object.keys(readJson(file).mcpServers), ['backdraw']);
});

test('desktop config: remove drops both the new and the old entry', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  writeJson(file, { mcpServers: { backdraw: { command: 'node' }, 'chatgpt-images': { command: 'node' }, other: { command: 'x' } } });
  assert.ok(updateDesktopConfig(file, null, { remove: true }));
  assert.deepEqual(Object.keys(readJson(file).mcpServers), ['other']);
});

test('desktop config: unreadable JSON is left untouched', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => updateDesktopConfig(file, desktopEntry('x')));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.equal(backups(file).length, 0);
});

test('migration copies config and jobs, never overwrites', () => {
  const root = tempDir();
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  writeJson(path.join(oldDir, 'data', 'config.json'), { outputDir: 'C:\\Pictures\\Old' });
  writeJson(path.join(oldDir, 'data', 'jobs.json'), [{ id: 'img_1', images: [{ path: 'C:\\Pictures\\Old\\a.png' }] }]);
  writeJson(path.join(newDir, 'data', 'jobs.json'), [{ id: 'img_new' }]);

  const report = migrateData(oldDir, newDir);
  assert.deepEqual(readJson(path.join(newDir, 'data', 'config.json')), { outputDir: 'C:\\Pictures\\Old' });
  assert.deepEqual(readJson(path.join(newDir, 'data', 'jobs.json')), [{ id: 'img_new' }]);
  assert.equal(report.length, 2);
  assert.match(report.find(r => r.includes('config.json')), /^copied/);
  assert.match(report.find(r => r.includes('jobs.json')), /^kept the existing/);
});

test('migration with no old data copies nothing', () => {
  const root = tempDir();
  assert.deepEqual(migrateData(path.join(root, 'missing'), path.join(root, 'new')), []);
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
});

test('extension steps: a reloaded extension needs nothing more (old folder note after a migration)', () => {
  const base = { dest: path.join('C:', 'home', '.backdraw'), legacyDir: path.join('C:', 'home', 'old'), wasInstalled: true, reloaded: true };
  assert.deepEqual(extensionSteps({ ...base, hasLegacy: false }), ['\nThe running extension was reloaded with the new version.']);
  const migrated = extensionSteps({ ...base, hasLegacy: true }).join('\n');
  assert.match(migrated, /reloaded with the new version/);
  assert.ok(migrated.includes(`The old folder ${base.legacyDir} is no longer used`));
});

test('extension steps: not reached after a migration names both possible reasons', () => {
  const dest = path.join('C:', 'home', '.backdraw');
  const legacyDir = path.join('C:', 'home', 'old');
  for (const wasInstalled of [false, true]) {
    const text = extensionSteps({ dest, legacyDir, hasLegacy: true, wasInstalled, reloaded: false }).join('\n');
    assert.match(text, /could not be reached/);
    assert.match(text, /Chrome is closed or Backdraw is turned off/);
    assert.ok(text.includes(`still loaded from the old folder ${path.join(legacyDir, 'extension')}`));
    assert.ok(text.includes(`"Load unpacked" and select ${path.join(dest, 'extension')}`));
    assert.ok(text.includes(`node "${path.join(dest, 'cli.js')}" status`));
    assert.ok(text.includes(`delete the old folder by hand: ${legacyDir}`));
    assert.doesNotMatch(text, /Load the Chrome extension once/);
  }
});

test('extension steps: not reached on an update says Chrome loads the new files itself', () => {
  const dest = path.join('C:', 'home', '.backdraw');
  const text = extensionSteps({ dest, legacyDir: path.join('C:', 'home', 'old'), hasLegacy: false, wasInstalled: true, reloaded: false }).join('\n');
  assert.match(text, /could not be reached \(Chrome is closed or Backdraw is turned off\)/);
  assert.match(text, /Chrome loads the new files when it starts, or when Backdraw is turned on/);
  assert.ok(text.includes(`node "${path.join(dest, 'cli.js')}" status`));
  assert.ok(text.includes(`If it was never loaded:`) && text.includes(path.join(dest, 'extension')));
  assert.doesNotMatch(text, /Load the Chrome extension once|old folder/);
});

test('extension steps: a first install explains loading the extension once', () => {
  const dest = path.join('C:', 'home', '.backdraw');
  const text = extensionSteps({ dest, legacyDir: path.join('C:', 'home', 'old'), hasLegacy: false, wasInstalled: false, reloaded: false }).join('\n');
  assert.match(text, /Load the Chrome extension once/);
  assert.match(text, /turn on "Developer mode"/);
  assert.ok(text.includes(path.join(dest, 'extension')));
  assert.doesNotMatch(text, /could not be reached|old folder/);
});

test('the deploy list covers every local file the deployed code requires', () => {
  const root = path.join(__dirname, '..');
  const jsFiles = p => (fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).flatMap(f => jsFiles(path.join(p, f)))
    : p.endsWith('.js') ? [p] : []);
  const required = [];
  for (const file of FILES.flatMap(f => jsFiles(path.join(root, f)))) {
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = require.resolve(path.resolve(path.dirname(file), spec));
      const top = path.relative(root, target).split(path.sep)[0];
      assert.ok(FILES.includes(top), `${path.relative(root, file)} requires ${spec}, but ${top} is not deployed`);
      required.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  for (const f of ['lib/results.js', 'lib/protocol.js', 'platform/index.js', 'package.json']) assert.ok(required.includes(f), f);
});
