// The right-click menu on images: its items for a collection list, what a clicked item id means, and
// where the "New collection…" window goes. No chrome.* calls here, so the tests can load it too.
(() => {
  const ROOT = 'backdraw';
  const ADD = 'backdraw:add:'; // + the collection name, as the host lists it
  const NEW = 'backdraw:new';
  const SEP = 'backdraw:sep';
  const OFF = 'backdraw:off';
  // Images on web pages and local files only: the extension's own pages show thumbnails of images
  // that are already in a collection.
  const where = { contexts: ['image'], documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'] };

  // collections: [{ name, count }] from the host, or null while it is not connected. msg(key) gives
  // the localized title.
  function menuItems(collections, msg) {
    const items = [{ id: ROOT, title: msg('menuAdd'), ...where }];
    if (!collections) return [...items, { id: OFF, parentId: ROOT, title: msg('menuOffline'), ...where, enabled: false }];
    for (const c of collections) items.push({ id: ADD + c.name, parentId: ROOT, title: `${c.name} (${c.count})`, ...where });
    if (collections.length) items.push({ id: SEP, parentId: ROOT, type: 'separator', ...where });
    items.push({ id: NEW, parentId: ROOT, title: msg('menuNew'), ...where });
    return items;
  }

  // { kind: 'add', name } | { kind: 'new' } | null for anything else.
  function parseMenuId(id) {
    const s = String(id ?? '');
    if (s === NEW) return { kind: 'new' };
    if (s.startsWith(ADD) && s.length > ADD.length) return { kind: 'add', name: s.slice(ADD.length) };
    return null;
  }

  // left/top that put a width x height window in the middle of win (a chrome.windows.Window); nothing
  // when win is unknown, so Chrome picks the place. Not clamped: a screen left of the main one has
  // negative coordinates.
  function centreOver(win, width, height) {
    if (!win || ![win.left, win.top, win.width, win.height].every(Number.isFinite)) return {};
    return { left: Math.round(win.left + (win.width - width) / 2), top: Math.round(win.top + (win.height - height) / 2) };
  }

  const api = { menuItems, parseMenuId, centreOver };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.backdrawMenus = api;
})();
