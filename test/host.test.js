'use strict';
// Runs a copy of the native host from a scratch folder (so its data/ and logs/ are scratch too), with
// its images folder there as well, on a private test pipe, and plays the Chrome extension over its
// stdio. The installed bridge, Chrome and the real images folder are never involved. The scratch
// folder stays inside the project (ignored as *.tmp), so the test never deletes anything outside it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const identity = require('../identity');
const { buildText } = require('../lib/prompt');
const { resultLines } = require('../lib/results');
const { png } = require('./png-fixture');

const ROOT = path.join(__dirname, '..');
const TAG = `backdraw-host-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\${TAG}` : path.join(os.tmpdir(), `${TAG}.sock`);
const DIR = path.join(ROOT, `.${TAG}.tmp`);
const IMAGES = path.join(DIR, 'images');
const PROJECT = { id: 'g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f', name: 'Images', url: 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/project' };
const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';

fs.mkdirSync(DIR);
for (const f of ['host.js', 'shared.js', 'identity.js', 'package.json', 'lib', 'platform']) fs.cpSync(path.join(ROOT, f), path.join(DIR, f), { recursive: true });
fs.mkdirSync(path.join(DIR, 'data'));
fs.writeFileSync(path.join(DIR, 'data', 'config.json'), JSON.stringify({ outputDir: IMAGES, project: PROJECT }));

const child = spawn(process.execPath, [path.join(DIR, 'host.js')], { cwd: DIR, env: { ...process.env, [identity.PIPE_ENV]: PIPE }, stdio: ['pipe', 'pipe', 'ignore'] });
const exited = new Promise(resolve => child.once('exit', resolve));
test.after(async () => {
  child.stdin.end(); // Chrome closing the connection stops the host
  await exited;
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Chrome's side (native messaging)

const fromHost = [];
let out = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  out = Buffer.concat([out, chunk]);
  while (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
    const size = out.readUInt32LE(0);
    fromHost.push(JSON.parse(out.subarray(4, 4 + size).toString('utf8')));
    out = out.subarray(4 + size);
  }
});

function toHost(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([head, body]));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, timeoutMs = 5000) {
  for (const start = Date.now(); ; await sleep(20)) {
    const v = check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}
const nextFromHost = type => until(() => { const i = fromHost.findIndex(m => m.type === type); return i >= 0 && fromHost.splice(i, 1)[0]; }, type);

// ---------------------------------------------------------------- the pipe (MCP server / CLI side)

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.destroy();
      const msg = JSON.parse(buf.slice(0, nl));
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else resolve(msg.result);
    });
  });
}

async function finished(jobId) {
  for (const start = Date.now(); Date.now() - start < 5000; await sleep(30)) {
    const job = await call('job', { jobId });
    if (!['queued', 'running'].includes(job.status)) return job;
  }
  throw new Error(`job ${jobId} did not finish`);
}

const b64 = buf => buf.toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

test('the host', async t => {
  await until(() => fs.existsSync(path.join(DIR, 'data', 'jobs.json')), 'the host to start');
  for (let i = 0; ; i++) {
    try { await call('status'); break; } catch (e) { if (i > 100) throw e; await sleep(50); }
  }
  toHost({ type: 'hello', version: 'test' });
  assert.equal((await nextFromHost('welcome')).project.url, PROJECT.url);

  await t.test('a bad aspect_ratio is refused before a job exists', async () => {
    await assert.rejects(call('generate', { prompt: 'x', aspect: '9:1' }), { code: 'BAD_REQUEST', message: /aspect_ratio 9:1 is outside the supported range 1:4 to 4:1/ });
    await assert.rejects(call('generate', { prompt: 'x', aspect: '1.5:1' }), { code: 'BAD_REQUEST', message: /use 3:2 instead/ });
    assert.deepEqual((await call('status')).queued, []);
  });

  await t.test('aspect + transparent: the run message, then both files saved for each cropped image', async () => {
    const legacy = path.join(DIR, 'legacy-out');
    const job = await call('generate', { prompt: 'A wide banner', aspect: '4:1', transparent: true, outputDir: legacy });
    assert.equal(job.aspect, '4:1');
    assert.equal(job.transparent, true);
    const { job: run } = await nextFromHost('run');
    assert.equal(run.id, job.id);
    assert.deepEqual(run.aspect, { w: 4, h: 1, label: '4:1' });
    assert.equal(run.transparent, true);
    assert.match(run.text, /\n\nA wide banner\n\nAspect ratio: make the image 3:1 \(landscape\)\. It will be cropped from the centre to exactly 4:1 afterwards, /);
    assert.match(run.text, /\nBackground: fully transparent \(PNG with an alpha channel\)\./);

    const original = png(2, { width: 1983, height: 793 });
    const cropped = png(6, { width: 1983, height: 496 });
    toHost({
      type: 'result', jobId: job.id, ok: true, status: 'succeeded', conversationUrl: CHAT_URL, title: 'Banner',
      images: [
        { data: b64(original), mime: 'image/png', width: 1983, height: 793, preview: b64(Buffer.from('preview-1')),
          crop: { data: b64(cropped), mime: 'image/png', width: 1983, height: 496 }, alpha: { transparentShare: 0, opaqueShare: 1 } },
        { data: b64(JPEG), mime: 'image/jpeg', width: 1983, height: 793, preview: null,
          crop: { data: b64(cropped), mime: 'image/png', width: 1983, height: 496 }, alpha: { transparentShare: 0, opaqueShare: 1 } },
      ],
    });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded');
    const [a, b] = done.images;
    assert.equal(path.dirname(a.path), IMAGES);
    assert.match(path.basename(a.path), /^\d{8}-\d{6}_a-wide-banner-1\.png$/);
    assert.equal(a.full.path, a.path.replace(/\.png$/, '_full.png'));
    assert.deepEqual(fs.readFileSync(a.path), cropped);
    assert.deepEqual(fs.readFileSync(a.full.path), original);
    assert.deepEqual({ ...a, path: 0, preview: 0, full: { ...a.full, path: 0 } }, {
      path: 0, width: 1983, height: 496, bytes: cropped.length, preview: 0,
      full: { path: 0, width: 1983, height: 793, bytes: original.length },
      aspect: '4:1', png: { colorType: 2, alphaChannel: false, trns: false }, alpha: { transparentShare: 0, opaqueShare: 1 },
    });
    assert.equal(fs.readFileSync(a.preview, 'utf8'), 'preview-1');
    // ChatGPT's JPEG keeps its own extension; the crop is a PNG.
    assert.match(path.basename(b.path), /-2\.png$/);
    assert.equal(b.full.path, b.path.replace(/\.png$/, '_full.jpg'));
    assert.deepEqual(fs.readFileSync(b.full.path), JPEG);
    assert.equal(b.png, null);
    assert.equal(b.preview, null);
    // The legacy output_dir copy is the cropped main file only.
    assert.deepEqual(done.copies.map(c => path.relative(legacy, c)), [path.basename(a.path), path.basename(b.path)]);
    assert.deepEqual(fs.readFileSync(done.copies[0]), cropped);

    const lines = resultLines(done);
    assert.ok(lines.includes(`Saved: ${a.path} (1983x496, cropped from the centre to 4:1)`));
    assert.ok(lines.includes(`Full image before cropping: ${a.full.path} (1983x793)`));
    // ChatGPT's 5:2 instead of the 3:1 it was asked for: the crop cut more than the prompt allowed.
    assert.ok(lines.some(l => l.startsWith('⚠ ChatGPT drew 1983x793 instead of 3:1, so the crop removed 37.5% of the height')));
    assert.ok(lines.some(l => /^⚠ TRANSPARENT BACKGROUND MISSING: ChatGPT returned an image without an alpha channel \(RGB PNG\)/.test(l)));
    assert.ok(lines.some(l => /without an alpha channel \(JPEG\)/.test(l)));
  });

  await t.test('without the new options nothing changes: same message, one file, no extra fields set', async () => {
    const job = await call('generate', { prompt: 'A void mage' });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.text, buildText({ prompt: 'A void mage', startUrl: PROJECT.url, references: [] }));
    assert.equal(run.aspect, null);
    assert.equal(run.transparent, false);
    const image = png(6, { width: 1254, height: 1254 });
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', images: [{ data: b64(image), mime: 'image/png', width: 1254, height: 1254, preview: null }] });
    const done = await finished(job.id);
    assert.equal(done.aspect, null);
    assert.equal(done.transparent, false);
    assert.equal(done.images.length, 1);
    const [im] = done.images;
    assert.deepEqual({ ...im, path: 0 }, {
      path: 0, width: 1254, height: 1254, bytes: image.length, preview: null, full: null, aspect: null,
      png: { colorType: 6, alphaChannel: true, trns: false }, alpha: null,
    });
    assert.deepEqual(fs.readFileSync(im.path), image);
    assert.deepEqual(resultLines(done).slice(1), [`Saved: ${im.path} (1254x1254)`]);
  });

  await t.test('an aspect ratio that was already right: no crop, one file', async () => {
    const job = await call('generate', { prompt: 'A landscape', aspect: '16:9' });
    await nextFromHost('run');
    const image = png(2, { width: 1672, height: 941 });
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', images: [{ data: b64(image), mime: 'image/png', width: 1672, height: 941, crop: null }] });
    const [im] = (await finished(job.id)).images;
    assert.equal(im.full, null);
    assert.equal(im.aspect, '16:9');
    assert.deepEqual(resultLines(await call('job', { jobId: job.id })).slice(-1), ['Aspect ratio: 16:9 requested, got 1672x941 (within 1%, not cropped).']);
  });

  await t.test('send_as_is: the text stays verbatim even with aspect and transparency', async () => {
    const job = await call('generate', { prompt: 'Yes, go ahead.', sendAsIs: true, aspect: '16:9', transparent: true, startUrl: CHAT_URL });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.text, 'Yes, go ahead.');
    assert.deepEqual(run.aspect, { w: 16, h: 9, label: '16:9' });
    toHost({ type: 'result', jobId: job.id, ok: false, status: 'cancelled' });
    assert.equal((await finished(job.id)).status, 'cancelled');
  });

  await t.test('collect mode: no text, but the crop target goes along', async () => {
    const job = await call('generate', { mode: 'collect', startUrl: CHAT_URL, aspect: '1920x1080' });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.mode, 'collect');
    assert.equal(run.text, '');
    assert.deepEqual(run.aspect, { w: 16, h: 9, label: '16:9' });
    assert.equal(run.transparent, false);
    toHost({ type: 'result', jobId: job.id, ok: false, status: 'failed', error: 'test over' });
    assert.equal((await finished(job.id)).status, 'failed');
  });
});
