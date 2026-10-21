'use strict';
// Reference collections on disk. Every function takes the collections folder (root) first, so the
// tests can use a temporary one. Layout: <root>/<folder>/collection.json, the images next to it and
// thumbs/<file>.jpg. Folder and file names are always made here, never taken from a request, and
// every path is checked to stay inside root.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sniffExt } = require('./naming');
const { MAX_COLLECTION_BYTES } = require('./limits');
const c = require('./collections');

const MANIFEST = 'collection.json';
const THUMBS = 'thumbs';
const MAX_THUMB_BYTES = 256 * 1024;
const SMALL_ORIGINAL = 200 * 1024; // shown as its own thumbnail when it has none
const THUMB_PAGE = 600000; // base64 chars of thumbnails per answer: Chrome caps host->extension messages at 1 MB
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function storeError(message, code) { return Object.assign(new Error(message), { code }); }

function inside(root, ...parts) {
  const p = path.join(root, ...parts);
  if (!c.isInside(root, p)) throw storeError('That path is outside the collections folder.', 'BAD_REQUEST');
  return p;
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch { return null; }
}

function writeManifest(dir, m) {
  const file = path.join(dir, MANIFEST);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, file);
}

// Entries a hand-edited manifest may hold that point anywhere else are left out everywhere.
const entries = m => (Array.isArray(m.images) ? m.images : []).filter(im => im && c.isPlainFile(im.file));
// The folder sits in Pictures, so an image may be deleted by hand: such an entry is not listed,
// counted or attached any more.
const present = (dir, m) => entries(m).filter(im => fs.existsSync(path.join(dir, im.file)));
const dim = v => (Number.isInteger(v) && v > 0 && v <= 100000 ? v : null);
// data: URLs can be megabytes long; only their type is worth keeping.
const cleanUrl = u => (typeof u !== 'string' || !u ? null : /^data:/i.test(u) ? u.slice(0, Math.min(u.indexOf(',') + 1 || 64, 64)) : u.slice(0, 2048));

function view(root, folder, m) {
  const dir = path.join(root, folder);
  const images = c.newestFirst(present(dir, m)).map(im => ({
    file: im.file, path: path.join(dir, im.file), sourceUrl: im.sourceUrl || null, pageUrl: im.pageUrl || null,
    addedAt: im.addedAt || null, width: im.width || null, height: im.height || null, bytes: im.bytes || null,
  }));
  return {
    name: c.validateName(m.name).name || folder, folder, path: dir, count: images.length,
    createdAt: m.createdAt || null, updatedAt: m.updatedAt || m.createdAt || null, images,
  };
}

// Every collection, most recently changed first; images newest first.
function list(root) {
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return dirs.filter(d => d.isDirectory())
    .map(d => { const m = readManifest(path.join(root, d.name)); return m && view(root, d.name, m); })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.name.localeCompare(b.name));
}

// loose: also match a loosely written name (for generating); changes only take an exact or
// differently-cased name.
function find(root, name, loose = true) {
  const all = list(root);
  const { collection, error, ties } = c.findCollection(all, name, { loose });
  if (collection) return collection;
  if (error === 'AMBIGUOUS') throw storeError(`"${name}" matches several collections: ${ties.map(x => `"${x.name}"`).join(', ')}. Use the exact name.`, 'AMBIGUOUS');
  throw storeError(`No reference collection matches "${name}". Available collections: ${all.map(x => `"${x.name}"`).join(', ') || '(none)'}`, 'NOT_FOUND');
}

function uniqueFolder(root, name) {
  const base = c.safeFolderName(name);
  for (let n = 1; ; n++) {
    const folder = n === 1 ? base : c.safeFolderName(`${c.cut(base, c.MAX_NAME - String(n).length - 1)} ${n}`);
    if (!fs.existsSync(inside(root, folder))) return folder;
  }
}

// The number after the highest one in the collection, and never a file that is already there.
function nextFile(dir, images, srcUrl, ext) {
  let n = images.reduce((max, im) => Math.max(max, parseInt(im.file, 10) || 0), 0);
  for (;;) {
    const file = c.fileNameFor(++n, srcUrl, ext);
    if (!fs.existsSync(path.join(dir, file))) return file;
  }
}

// A full signature, not just the first two or three bytes (lib/naming.js sniffExt is enough for
// images ChatGPT made, not for bytes from any web page).
function imageExt(b) {
  const at = (from, to) => b.subarray(from, to).toString('latin1');
  if (b.subarray(0, 16).equals(PNG_HEAD)) return 'png'; // signature and the IHDR chunk that must come first
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (at(0, 6) === 'GIF87a' || at(0, 6) === 'GIF89a') return 'gif';
  if (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP' && /^VP8[ LX]$/.test(at(12, 16))) return 'webp';
  return null;
}

// The bytes decide what the file is, whatever mime the caller claims.
function decodeImage(data) {
  const tooLarge = storeError(`The image is larger than ${MAX_COLLECTION_BYTES / 1024 / 1024} MB.`, 'TOO_LARGE');
  if (typeof data !== 'string' || !data) throw storeError('No image data was sent.', 'BAD_REQUEST');
  if (data.length > Math.ceil(MAX_COLLECTION_BYTES / 3) * 4 + 4) throw tooLarge;
  const buf = Buffer.from(data, 'base64');
  if (buf.length > MAX_COLLECTION_BYTES) throw tooLarge;
  if (buf.length < 24 || !imageExt(buf)) throw storeError('Only png, jpeg, webp and gif images can be saved.', 'BAD_REQUEST');
  return buf;
}

function decodeThumb(data) {
  if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_THUMB_BYTES / 3) * 4) return null;
  const buf = Buffer.from(data, 'base64');
  return buf.length >= 24 && imageExt(buf) === 'jpg' ? buf : null;
}

// p: { collection, create, data (base64), sourceUrl, pageUrl, thumb (base64 jpeg), width, height }.
// The same bytes twice in one collection are kept once (duplicate: true).
function add(root, p, now = new Date()) {
  const { name, error } = c.validateName(p.collection);
  if (error) throw storeError(error, 'BAD_REQUEST');
  const buf = decodeImage(p.data);
  const found = c.findCollection(list(root), name, { loose: false });
  if (found.error === 'AMBIGUOUS') throw storeError(`"${name}" matches several collections; use the exact name.`, 'AMBIGUOUS');
  if (found.error && !p.create) throw storeError(`There is no collection named "${name}".`, 'NOT_FOUND');
  const stamp = now.toISOString();
  const folder = found.collection ? found.collection.folder : uniqueFolder(root, name);
  const dir = inside(root, folder);
  let m = found.collection && readManifest(dir);
  if (!m) {
    fs.mkdirSync(dir, { recursive: true });
    m = { name, createdAt: stamp, updatedAt: stamp, images: [] };
  }
  if (!Array.isArray(m.images)) m.images = [];
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const same = present(dir, m).find(im => im.sha256 === sha256);
  if (same) return { name: m.name, folder, file: same.file, count: present(dir, m).length, created: false, duplicate: true };
  const file = nextFile(dir, entries(m), p.sourceUrl, imageExt(buf));
  fs.writeFileSync(inside(root, folder, file), buf, { flag: 'wx' });
  const thumb = decodeThumb(p.thumb);
  if (thumb) {
    fs.mkdirSync(inside(root, folder, THUMBS), { recursive: true });
    fs.writeFileSync(inside(root, folder, THUMBS, `${file}.jpg`), thumb);
  }
  m.images.push({
    file, sourceUrl: cleanUrl(p.sourceUrl), pageUrl: cleanUrl(p.pageUrl), addedAt: stamp,
    bytes: buf.length, width: dim(p.width), height: dim(p.height), sha256,
  });
  m.updatedAt = stamp;
  writeManifest(dir, m);
  return { name: m.name, folder, file, count: present(dir, m).length, created: !found.collection, duplicate: false };
}

// Renames the folder too; refuses a name another collection already has.
function rename(root, name, newName, now = new Date()) {
  const v = c.validateName(newName);
  if (v.error) throw storeError(v.error, 'BAD_REQUEST');
  const col = find(root, name, false);
  const taken = c.findCollection(list(root).filter(x => x.folder !== col.folder), v.name, { loose: false });
  if (!taken.error || taken.error === 'AMBIGUOUS') throw storeError(`A collection named "${v.name}" already exists.`, 'EXISTS');
  let folder = col.folder;
  const wanted = c.safeFolderName(v.name);
  if (wanted !== folder) {
    // A change of case only is the same folder on Windows: rename it in place.
    folder = wanted.toLowerCase() === folder.toLowerCase() ? wanted : uniqueFolder(root, v.name);
    fs.renameSync(inside(root, col.folder), inside(root, folder));
  }
  const dir = inside(root, folder);
  const m = readManifest(dir) || { images: [] };
  Object.assign(m, { name: v.name, updatedAt: now.toISOString() });
  writeManifest(dir, m);
  return { name: v.name, oldName: col.name, folder, path: dir };
}

function unlinkIfThere(file) {
  try { fs.unlinkSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

function rmdirIfEmpty(dir) {
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
}

// Deletes only what the collection itself wrote (its images, their thumbnails and the manifest), then
// the folders if they are empty. Anything else is left and reported. Images that could not be
// deleted (e.g. open in another program) stay in the manifest; a thumbnail that stays is only reported.
function remove(root, name) {
  const col = find(root, name, false);
  const dir = inside(root, col.folder);
  const m = readManifest(dir) || {};
  let deleted = 0;
  const failed = [];
  const kept = [];
  for (const im of entries(m)) {
    try {
      if (unlinkIfThere(inside(root, col.folder, im.file))) deleted++;
    } catch (e) {
      failed.push(`${im.file} (${e.code || e.message})`);
      kept.push(im);
      continue; // its thumbnail stays with it
    }
    try { unlinkIfThere(inside(root, col.folder, THUMBS, `${im.file}.jpg`)); } catch (e) { failed.push(`${THUMBS}/${im.file}.jpg (${e.code || e.message})`); }
  }
  if (kept.length) {
    m.images = kept;
    writeManifest(dir, m);
  } else {
    rmdirIfEmpty(inside(root, col.folder, THUMBS));
    unlinkIfThere(inside(root, col.folder, MANIFEST));
    rmdirIfEmpty(dir);
  }
  let left = [];
  try { left = fs.readdirSync(dir); } catch {}
  return { name: col.name, folder: col.folder, path: dir, deleted, left, failed };
}

function removeImage(root, name, file, now = new Date()) {
  const col = find(root, name, false);
  const dir = inside(root, col.folder);
  const m = readManifest(dir) || {};
  const images = Array.isArray(m.images) ? m.images : [];
  const i = c.isPlainFile(file) ? images.findIndex(im => im && im.file === file) : -1;
  if (i < 0) throw storeError(`Collection "${col.name}" has no image "${file}".`, 'NOT_FOUND');
  unlinkIfThere(inside(root, col.folder, file));
  try { unlinkIfThere(inside(root, col.folder, THUMBS, `${file}.jpg`)); } catch {}
  images.splice(i, 1);
  m.images = images;
  m.updatedAt = now.toISOString();
  writeManifest(dir, m);
  return { name: col.name, file, count: present(dir, m).length };
}

function readThumb(root, folder, im) {
  try {
    const buf = fs.readFileSync(inside(root, folder, THUMBS, `${im.file}.jpg`));
    if (buf.length <= MAX_THUMB_BYTES) return { data: buf.toString('base64'), mime: 'image/jpeg' };
  } catch {}
  try {
    const file = inside(root, folder, im.file);
    if (fs.statSync(file).size <= SMALL_ORIGINAL) {
      const buf = fs.readFileSync(file);
      const ext = sniffExt(buf);
      if (MIME[ext]) return { data: buf.toString('base64'), mime: MIME[ext] };
    }
  } catch {}
  return { data: null, mime: null };
}

// Thumbnails newest first, a page at a time (next: the offset to ask for, or null at the end).
function thumbs(root, name, offset = 0, budget = THUMB_PAGE) {
  const col = find(root, name, false);
  const out = [];
  let size = 0;
  let i = Math.max(0, Math.floor(Number(offset) || 0));
  for (; i < col.images.length; i++) {
    const im = col.images[i];
    const t = readThumb(root, col.folder, im);
    const len = t.data ? t.data.length : 0;
    if (out.length && size + len > budget) break;
    size += len;
    out.push({ file: im.file, width: im.width, height: im.height, ...t });
  }
  return { name: col.name, total: col.images.length, thumbs: out, next: i < col.images.length ? i : null };
}

// An image of a collection (from list/find) as a reference for a job.
function readImage(root, col, im) {
  const file = inside(root, col.folder, im.file);
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    throw storeError(`Cannot read ${im.file} from collection "${col.name}" (${e.code || e.message}).`, 'NOT_FOUND');
  }
  return { name: im.file, mime: MIME[sniffExt(buf)] || 'image/png', data: buf.toString('base64') };
}

module.exports = { MANIFEST, THUMBS, THUMB_PAGE, list, find, add, rename, remove, removeImage, thumbs, readImage };
