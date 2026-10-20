'use strict';
// Paths, small file helpers and the named-pipe client shared by the MCP server and the CLI.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
// Single version source; install.js copies package.json next to these files.
const VERSION = require('./package.json').version;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const PREVIEW_DIR = path.join(DATA_DIR, 'previews');
const HOST_NAME = 'com.claude.chatgpt_image_bridge';
const USER_TAG = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
const PIPE_PATH = process.env.CGB_PIPE || `\\\\.\\pipe\\chatgpt-image-bridge-${USER_TAG}`; // override: tests only

const NOT_RUNNING =
  'The ChatGPT bridge is not running: Google Chrome is closed, or the browser extension ' +
  'is not loaded/enabled. Ask the user to open Chrome; the extension connects by itself.';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class BridgeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// One request per connection: write a JSON line, read one JSON line back.
function call(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE_PATH);
    let buf = '';
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new BridgeError(`The bridge did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`, 'TIMEOUT')),
      timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { return finish(e); }
      if (msg.error) finish(new BridgeError(msg.error.message, msg.error.code));
      else finish(null, msg.result);
    });
    sock.on('error', e => finish(['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(e.code) ? new BridgeError(NOT_RUNNING, 'NOT_RUNNING') : e));
    sock.on('close', () => finish(new BridgeError('The bridge closed the connection unexpectedly.', 'CLOSED')));
  });
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// Reads reference images in the caller's own context (relative paths = its working folder).
function readReferences(list) {
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  if (list.length > 4) throw new Error('At most 4 reference images per request.');
  return list.map(p => {
    const file = path.resolve(String(p));
    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mime) throw new Error(`Reference is not a png/jpg/webp/gif image: ${file}`);
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { throw new Error(`Cannot read reference image ${file} (${e.code || e.message}).`); }
    if (buf.length > 20 * 1024 * 1024) throw new Error(`Reference image is larger than 20 MB: ${file}`);
    return { name: path.basename(file), mime, data: buf.toString('base64') };
  });
}

// Copies a finished job's images into the folder the caller asked for (once), from the caller's
// own process so the copy lands where the caller can see it.
async function copyResults(job) {
  if (job.status !== 'succeeded' || !job.copyTo || (job.copies && job.copies.length)) return job;
  try {
    fs.mkdirSync(job.copyTo, { recursive: true });
    const copies = job.images.map(im => {
      const ext = path.extname(im.path);
      const base = path.basename(im.path, ext);
      let dest = path.join(job.copyTo, `${base}${ext}`);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(job.copyTo, `${base}_${n}${ext}`);
      fs.copyFileSync(im.path, dest);
      return dest;
    });
    return await call('mark_copied', { jobId: job.id, paths: copies });
  } catch (e) {
    return { ...job, copyError: e.message };
  }
}

module.exports = {
  VERSION, ROOT, DATA_DIR, LOG_DIR, CONFIG_FILE, JOBS_FILE, PREVIEW_DIR, HOST_NAME, PIPE_PATH,
  NOT_RUNNING, BridgeError, readJson, writeJson, call, readReferences, copyResults,
};
