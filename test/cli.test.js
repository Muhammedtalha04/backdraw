'use strict';
// Runs the CLI as a child process against a fake host on a private test pipe.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');
const identity = require('../identity');

const CLI = path.join(__dirname, '..', 'cli.js');
const TAG = `backdraw-cli-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\${TAG}` : path.join(os.tmpdir(), `${TAG}.sock`);
const CHAT_URL = 'https://chatgpt.com/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';

const generated = [];
const host = net.createServer(sock => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl));
    if (req.method === 'generate') generated.push(req.params);
    const job = { id: 'img_0c11c11c', status: 'succeeded', step: 'succeeded', images: [], copies: [] };
    sock.write(JSON.stringify({ id: req.id, result: job }) + '\n');
  });
});
test.before(() => new Promise(resolve => host.listen(PIPE, resolve)));
test.after(() => new Promise(resolve => host.close(() => resolve())));

const run = (...args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { env: { ...process.env, [identity.PIPE_ENV]: PIPE } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

test('generate --aspect --transparent and collect --aspect reach the host', async () => {
  generated.length = 0;
  assert.equal((await run('generate', 'a', 'sticker', '--aspect', '4:1', '--transparent')).code, 0);
  assert.equal((await run('generate', 'plain')).code, 0);
  assert.equal((await run('collect', CHAT_URL, '--aspect', '16:9')).code, 0);
  assert.deepEqual(generated.map(p => [p.prompt, p.aspect, p.transparent]), [['a sticker', '4:1', true], ['plain', undefined, false], [undefined, '16:9', undefined]]);
  assert.equal(generated[2].mode, 'collect');
});

test('--transparent never swallows the next word', async () => {
  generated.length = 0;
  await run('generate', '--transparent', 'a', 'fox');
  assert.equal(generated[0].prompt, 'a fox');
  assert.equal(generated[0].transparent, true);
});

test('--aspect without a ratio is an error, nothing is sent', async () => {
  generated.length = 0;
  const r = await run('generate', 'x', '--aspect');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--aspect needs a ratio, e\.g\. --aspect 16:9/);
  assert.equal(generated.length, 0);
});
