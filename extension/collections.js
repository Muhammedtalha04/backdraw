// Reference collections: right-click an image on any page, "Add to Backdraw". Loaded by background.js
// (importScripts) and shares its globals (hostReady, post, connect, log, setBadge, b64ToBytes,
// bytesToB64). The host owns the collections folder; this side only downloads the picture the user
// clicked, makes sure it is an image, adds a thumbnail and sends the bytes over the native port.
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // lib/limits.js MAX_COLLECTION_BYTES; the host checks it again
const CALL_CHUNK = 512 * 1024; // base64 chars per call_chunk message
const THUMB_PX = 256;
const PENDING_TTL = 10 * 60 * 1000;
const DOWNLOAD_MS = 90 * 1000; // per download of the clicked image (in the worker, then in the page)
// What the popup may ask the host through the worker (the host has its own allow-list too).
const PAGE_HOST_METHODS = new Set(['list_collections', 'rename_collection', 'delete_collection', 'delete_collection_image', 'collection_thumbs']);

let collections = []; // [{ name, count }] as the host last sent them
let shownMenu = null; // the menu Chrome shows now, so the same one is not rebuilt
let latestMenu = null; // the menu asked for last
let menuChain = Promise.resolve();
let callSeq = 0;
let badgeTimer = null;
const hostCalls = new Map(); // reqId -> { resolve, reject, timer }
const readyWaiters = new Set();
const pendingNew = new Map(); // key -> { source, at, image, windowId } while a "New collection" window is open

const tr = (key, vars) => i18n.t(key, vars);
const userError = (key, vars) => new Error(tr(key, vars));
const tooLargeError = () => Object.assign(userError('errTooLarge', { mb: MAX_IMAGE_BYTES / 1048576 }), { tooLarge: true });

// ---------------------------------------------------------------- calls to the host

// A click can wake the worker before the native port is up: wait for the host's welcome a moment.
function whenHostReady(ms = 8000) {
  if (hostReady) return Promise.resolve();
  connect();
  return new Promise((resolve, reject) => {
    const w = { resolve, timer: setTimeout(() => { readyWaiters.delete(w); reject(userError('errNotConnected')); }, ms) };
    readyWaiters.add(w);
  });
}

// data (base64) goes first in call_chunk pieces, then the call itself; the host puts them together.
async function callHost(method, params = {}, data = null, timeoutMs = 60000) {
  await whenHostReady();
  const reqId = `c${++callSeq}-${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { hostCalls.delete(reqId); reject(userError('errTimeout')); }, timeoutMs);
    hostCalls.set(reqId, { resolve, reject, timer });
    const total = data ? Math.max(1, Math.ceil(data.length / CALL_CHUNK)) : 0;
    let sent = true;
    for (let seq = 0; seq < total && sent; seq++) sent = post({ type: 'call_chunk', reqId, seq, total, data: data.slice(seq * CALL_CHUNK, (seq + 1) * CALL_CHUNK) });
    if (!sent || !post({ type: 'call', reqId, method, params })) settleHostCall({ reqId, ok: false, error: tr('errNotConnected') });
  });
}

function settleHostCall(msg) {
  const c = hostCalls.get(msg.reqId);
  if (!c) return;
  hostCalls.delete(msg.reqId);
  clearTimeout(c.timer);
  if (msg.ok) c.resolve(msg.result);
  else c.reject(Object.assign(new Error(msg.error || 'Backdraw reported an error.'), { code: msg.code }));
}

// background.js calls these when the host says welcome, sends a new list, or goes away.
function collectionsOnline(list) {
  for (const w of readyWaiters) { clearTimeout(w.timer); w.resolve(); }
  readyWaiters.clear();
  if (Array.isArray(list)) collections = list;
  rebuildMenu();
}

function collectionsChanged(list) {
  collections = Array.isArray(list) ? list : [];
  rebuildMenu();
}

function collectionsOffline() {
  for (const reqId of [...hostCalls.keys()]) settleHostCall({ reqId, ok: false, error: tr('errNotConnected') });
  rebuildMenu();
}

// ---------------------------------------------------------------- right-click menu

// Chrome has no "replace the menu": remove everything and create it again, one rebuild at a time.
// A rebuild that a newer one has overtaken is skipped, so the last call always wins.
function rebuildMenu() {
  const items = backdrawMenus.menuItems(hostReady ? collections : null, key => chrome.i18n.getMessage(key) || key);
  const sig = latestMenu = JSON.stringify(items);
  menuChain = menuChain.then(async () => {
    if (sig !== latestMenu || sig === shownMenu) return;
    shownMenu = null;
    await new Promise(r => chrome.contextMenus.removeAll(() => r(chrome.runtime.lastError)));
    for (const item of items) await new Promise(r => chrome.contextMenus.create(item, () => r(chrome.runtime.lastError)));
    shownMenu = sig;
  }).catch(e => log('warn', 'context menu update failed', String(e)));
}

chrome.runtime.onInstalled.addListener(() => rebuildMenu());
chrome.runtime.onStartup.addListener(() => rebuildMenu());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = backdrawMenus.parseMenuId(info.menuItemId);
  if (!item) return;
  const tabId = tab && tab.id >= 0 ? tab.id : -1;
  // Chrome leaves srcUrl out when the address is too long to pass on (a data: image over 2 MB).
  if (!info.srcUrl) { notifyUser(tabId, tr('errNoSource'), true); return; }
  const source = { srcUrl: info.srcUrl, pageUrl: info.pageUrl || (tab && tab.url) || '', frameId: info.frameId || 0, tabId };
  if (item.kind === 'new') openNewCollection(source).catch(e => log('warn', 'new collection window failed', String(e)));
  else addToCollection(source, item.name, false).catch(() => {}); // the user already saw the error
});

// ---------------------------------------------------------------- the clicked image

function sniffImageMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'GIF8') return 'image/gif';
  return null;
}

// Runs inside the frame that shows the image, where its blob: URLs and the site's own rules work.
// An image that is already shown can be copied through a canvas when fetching is refused (or, with
// canvasOnly, when only the page can decode it, like SVG). svg: the SVG's bytes (base64) when the
// worker has them already.
async function readImageInPage(src, max, timeoutMs, canvasOnly, svg) {
  const asResult = async blob => {
    if (blob.size > max) return { tooLarge: true };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { data: btoa(bin), mime: blob.type || '' };
  };
  let error = '';
  if (!canvasOnly) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs);
    try {
      const res = await fetch(src, { credentials: 'include', signal: ac.signal });
      if (res.ok) {
        // Counted while it arrives (like readCapped in the worker), so it stops at the limit.
        const chunks = [];
        let size = 0;
        const reader = res.body ? res.body.getReader() : null;
        for (let r; reader && !(r = await reader.read()).done;) {
          if ((size += r.value.length) > max) { ac.abort(); return { tooLarge: true }; }
          chunks.push(r.value);
        }
        return asResult(new Blob(chunks, { type: res.headers.get('content-type') || '' }));
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = String((e && e.message) || e);
    } finally {
      clearTimeout(timer);
    }
  }
  const shown = Array.from(document.images).find(i => (i.currentSrc || i.src) === src);
  let img = shown && shown.naturalWidth ? shown : null;
  let url = null;
  if (svg) {
    // As this page's own blob: URL the SVG never taints the canvas, also when the page shows it from
    // another site. A strict img-src policy refuses it: then the shown <img> is copied instead.
    url = URL.createObjectURL(new Blob([Uint8Array.from(atob(svg), ch => ch.charCodeAt(0))], { type: 'image/svg+xml' }));
    const own = new Image();
    own.src = url;
    if (await own.decode().then(() => true, () => false)) img = own;
  }
  try {
    if (!img) return { error: error || 'image not found in the page' };
    const canvas = document.createElement('canvas');
    // An SVG without a size of its own is drawn at the size the page shows it.
    canvas.width = img.naturalWidth || (shown && shown.width) || 1024;
    canvas.height = img.naturalHeight || (shown && shown.height) || 1024;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return blob ? asResult(blob) : { error: `${error}; canvas export failed` };
  } catch (e) {
    return { error: `${error}; ${String((e && e.message) || e)}` }; // a cross-site image taints the canvas
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function readInPage({ srcUrl, tabId, frameId }, canvasOnly = false, svg = null) {
  return chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] }, func: readImageInPage, args: [srcUrl, MAX_IMAGE_BYTES, DOWNLOAD_MS, canvasOnly, svg],
  }).then(([res]) => (res && res.result) || { error: 'no answer from the page' }, e => ({ error: String((e && e.message) || e) }));
}

// Counted while it arrives: a body without (or with a wrong) Content-Length, or one that never ends,
// stops at the limit instead of filling memory.
async function readCapped(res, ac) {
  const chunks = [];
  let size = 0;
  const reader = res.body ? res.body.getReader() : null;
  for (let r; reader && !(r = await reader.read()).done;) {
    if ((size += r.value.length) > MAX_IMAGE_BYTES) { ac.abort(); throw tooLargeError(); }
    chunks.push(r.value);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

async function downloadClicked(source) {
  const { srcUrl, tabId } = source;
  let why = '';
  if (!/^blob:/i.test(srcUrl)) { // a page's blob: URL can only be read inside that page
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`no answer in ${DOWNLOAD_MS / 1000} s`)), DOWNLOAD_MS);
    try {
      const res = await fetch(srcUrl, { credentials: 'include', signal: ac.signal });
      if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) { ac.abort(); throw tooLargeError(); }
      if (res.ok) return await readCapped(res, ac);
      why = `HTTP ${res.status}`;
    } catch (e) {
      if (e.tooLarge) throw e;
      why = String((e && e.message) || e);
    } finally {
      clearTimeout(timer);
    }
  }
  if (tabId >= 0) {
    const r = await readInPage(source);
    if (r.tooLarge) throw tooLargeError();
    if (r.data) return new Blob([b64ToBytes(r.data)], { type: r.mime });
    if (r.error) why = why ? `${why}; ${r.error}` : r.error;
  }
  throw userError('errDownload', { reason: why || '?' });
}

async function collectionThumb(bmp) {
  const scale = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
}

const looksLikeSvg = (blob, bytes) => /svg/i.test(blob.type) || /<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));

// png/jpeg/webp/gif are kept as they are; anything else Chrome can decode (avif, bmp, ico…, or SVG
// through the page) is saved as PNG, so every viewer and ChatGPT can open it.
async function prepareImage(source) {
  const blob = await downloadClicked(source);
  if (blob.size > MAX_IMAGE_BYTES) throw tooLargeError();
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let mime = sniffImageMime(bytes);
  let bmp = await createImageBitmap(new Blob([bytes], { type: mime || blob.type })).catch(() => null);
  if (!bmp && source.tabId >= 0) {
    // Only a page can draw SVG; it gets the bytes, since the <img> it shows may be from another site.
    const r = await readInPage(source, true, looksLikeSvg(blob, bytes) ? bytesToB64(bytes) : null);
    if (r.tooLarge) throw tooLargeError();
    if (r.data) {
      bytes = b64ToBytes(r.data);
      mime = sniffImageMime(bytes);
      bmp = await createImageBitmap(new Blob([bytes], { type: mime || '' })).catch(() => null);
    }
  }
  if (!bmp) throw userError('errNotImage');
  try {
    if (!mime) {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const png = await canvas.convertToBlob({ type: 'image/png' });
      if (png.size > MAX_IMAGE_BYTES) throw tooLargeError();
      bytes = new Uint8Array(await png.arrayBuffer());
      mime = 'image/png';
    }
    return { data: bytesToB64(bytes), mime, width: bmp.width, height: bmp.height, thumb: await collectionThumb(bmp) };
  } finally {
    bmp.close();
  }
}

// data: URLs can be megabytes long; the host keeps only their type anyway.
const shortUrl = u => (/^data:/i.test(u || '') ? u.slice(0, Math.min(u.indexOf(',') + 1 || 64, 64)) : String(u || '').slice(0, 2048));

async function addToCollection(source, name, create, prepared) {
  if (source.tabId >= 0) await showPageToast(source.tabId, tr('toastAdding', { name }), 'busy');
  try {
    const img = await (prepared || prepareImage(source));
    const r = await callHost('collection_add', {
      collection: name, create, mime: img.mime, width: img.width, height: img.height, thumb: img.thumb,
      sourceUrl: shortUrl(source.srcUrl), pageUrl: shortUrl(source.pageUrl),
    }, img.data, 120000);
    await notifyUser(source.tabId, tr(r.duplicate ? 'toastDuplicate' : 'toastAdded', { name: r.name, images: i18n.images(r.count) }), false);
    return r;
  } catch (e) {
    await notifyUser(source.tabId, String((e && e.message) || e), true);
    throw e;
  }
}

// ---------------------------------------------------------------- the in-page note

// Injected only right after the user's own click: a small note in the page corner that removes itself.
function pageToast(text, kind) {
  const old = document.getElementById('backdraw-toast');
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = 'backdraw-toast';
  host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const box = document.createElement('div');
  box.textContent = text;
  box.style.cssText = 'font:13px/1.4 "Segoe UI",system-ui,sans-serif;color:#fff;padding:10px 14px;border-radius:10px;max-width:340px;' +
    `box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .3s;background:${kind === 'error' ? '#c62828' : '#1d1d1f'};`;
  host.attachShadow({ mode: 'closed' }).append(box);
  document.documentElement.append(host);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => host.remove(), 300); }, kind === 'busy' ? 30000 : kind === 'error' ? 4000 : 2500);
}

function showPageToast(tabId, text, kind) {
  return chrome.scripting.executeScript({ target: { tabId }, func: pageToast, args: [text, kind] }).then(() => true, () => false);
}

// Pages that can't be scripted (chrome://, the PDF viewer, the Web Store) get the toolbar badge.
function flashBadge(text, error) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeText({ text: error ? '!' : '✓' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: error ? '#d93025' : '#1a7f37' }).catch(() => {});
  chrome.action.setTitle({ title: text }).catch(() => {});
  badgeTimer = setTimeout(() => { setBadge(); chrome.action.setTitle({ title: 'Backdraw' }).catch(() => {}); }, error ? 4000 : 2500);
}

async function notifyUser(tabId, text, error) {
  if (tabId >= 0 && await showPageToast(tabId, text, error ? 'error' : 'ok')) return;
  flashBadge(text, error);
}

// ---------------------------------------------------------------- "New collection…" window

function forgetPending(key) {
  pendingNew.delete(key);
  chrome.storage.session.remove(`pending:${key}`).catch(() => {});
}

// The image is prepared while the user types the name. The click is kept in session storage too:
// the worker may be stopped while the window is open, and then downloads it again.
async function openNewCollection(source) {
  for (const [key, e] of pendingNew) if (Date.now() - e.at > PENDING_TTL) forgetPending(key);
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const entry = { source, at: Date.now(), image: prepareImage(source) };
  entry.image.catch(() => {}); // shown in the window when it asks
  pendingNew.set(key, entry);
  const win = await chrome.windows.create({ url: chrome.runtime.getURL(`collection.html#${key}`), type: 'popup', width: 380, height: 470, focused: true });
  entry.windowId = win.id;
  if (source.srcUrl.length < 1000000) await chrome.storage.session.set({ [`pending:${key}`]: { source, at: entry.at, windowId: win.id } }).catch(() => {});
}

// A window closed with its own × (not Cancel or Escape) lets go of the prepared image too.
chrome.windows.onRemoved.addListener(windowId => {
  for (const [key, e] of pendingNew) if (e.windowId === windowId) forgetPending(key);
});

async function pendingEntry(key) {
  let entry = pendingNew.get(key);
  if (!entry) {
    const stored = (await chrome.storage.session.get(`pending:${key}`))[`pending:${key}`];
    if (!stored || Date.now() - stored.at > PENDING_TTL) throw userError('errExpired');
    entry = { ...stored, image: prepareImage(stored.source) };
    entry.image.catch(() => {});
    pendingNew.set(key, entry);
  }
  return entry;
}

// ---------------------------------------------------------------- requests from the extension's pages

const pageRequests = new Map([
  ['collection:pending', async msg => {
    const img = await (await pendingEntry(msg.key)).image;
    return { thumb: img.thumb, width: img.width, height: img.height, names: collections.map(c => c.name) };
  }],
  ['collection:create', async msg => {
    const name = String(msg.name || '').replace(/\s+/g, ' ').trim();
    if (!name || Array.from(name).length > 64) throw userError('nameInvalid');
    const entry = await pendingEntry(msg.key);
    const r = await addToCollection(entry.source, name, true, entry.image);
    forgetPending(msg.key);
    return r;
  }],
  ['collection:cancel', async msg => { forgetPending(msg.key); return {}; }],
  ['host:call', async msg => {
    if (!PAGE_HOST_METHODS.has(msg.method)) throw new Error(`Not allowed: ${msg.method}`);
    return { result: await callHost(msg.method, msg.params || {}) };
  }],
]);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = msg && pageRequests.get(msg.type);
  if (!handler || sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return;
  handler(msg).then(r => reply({ ok: true, ...r }), e => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
