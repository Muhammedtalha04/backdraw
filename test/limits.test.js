'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_REFS, MAX_REF_BYTES, MAX_REFS_TOTAL_BYTES, MAX_COLLECTION_BYTES } = require('../lib/limits');
const { readReferences } = require('../shared');

test('limits: 16 references per message (provisional), 20 MB each, 80 MB together, 25 MB per collection image', () => {
  assert.equal(MAX_REFS, 16);
  assert.equal(MAX_REF_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_REFS_TOTAL_BYTES, 4 * MAX_REF_BYTES);
  assert.equal(MAX_COLLECTION_BYTES, 25 * 1024 * 1024);
});

test('readReferences: the same limit as the host and the MCP schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-refs-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = Array.from({ length: MAX_REFS + 1 }, (_, i) => {
    const file = path.join(dir, `r${i}.png`);
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, i]));
    return file;
  });
  assert.equal(readReferences(files.slice(0, MAX_REFS)).length, MAX_REFS);
  assert.throws(() => readReferences(files), new RegExp(`At most ${MAX_REFS} reference images`));
});

test('nothing else hard-codes the old limit of 4 references', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['host.js', 'shared.js', 'mcp-server.js', 'cli.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /MAX_REFS = \d|maxItems: 4\b|length > 4\b|up to 4\b/, f);
    assert.doesNotMatch(src, /MAX_REF_BYTES = |20 \* 1024 \* 1024|than 20 MB/, f); // one byte limit, from lib/limits.js
  }
});
