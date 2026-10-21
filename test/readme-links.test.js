'use strict';
// Every local image and link in the READMEs must point at a file that is in the repository
// (a missing banner or demo GIF shows up as a broken image on GitHub).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const READMES = ['README.md', 'README.tr.md'];

// Markdown links/images and HTML src/href attributes.
function localTargets(text) {
  const found = [];
  for (const re of [/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, /\b(?:src|href)\s*=\s*"([^"]+)"/g]) {
    for (const m of text.matchAll(re)) found.push(m[1]);
  }
  return found
    .filter(t => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#'))
    .map(t => decodeURIComponent(t.split('#')[0].split('?')[0]))
    // ../../issues and similar are GitHub web routes outside the repository tree.
    .filter(t => !path.relative(ROOT, path.resolve(ROOT, t)).startsWith('..'));
}

// Files in the git index, or null when this is not a git checkout (e.g. a release zip).
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

test('localTargets finds markdown and HTML links and skips URLs, anchors and GitHub routes', () => {
  const text = '<img src="a/b.png"> [x](docs/c.md#part) ![y](d.gif "t") [w](https://e.com) [z](#top) ' +
    '<a href="README.tr.md">tr</a> [i](../../issues) [m](mailto:a@b.c)';
  assert.deepEqual(localTargets(text).sort(), ['README.tr.md', 'a/b.png', 'd.gif', 'docs/c.md']);
});

for (const readme of READMES) {
  test(`${readme}: every local image and link exists in the repository`, () => {
    const targets = localTargets(fs.readFileSync(path.join(ROOT, readme), 'utf8'));
    assert.ok(targets.length > 0, 'expected at least one local link');
    const tracked = trackedFiles();
    for (const t of targets) {
      const full = path.resolve(ROOT, t);
      assert.ok(fs.existsSync(full), `${readme} links to ${t}, which does not exist`);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (tracked && fs.statSync(full).isFile()) assert.ok(tracked.has(rel), `${readme} links to ${t}, which is not committed`);
    }
  });
}
