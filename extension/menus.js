// The right-click menu on images: its items for a collection list, and what a clicked item id means.
// No chrome.* calls here, so the tests can load it too.
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

  const api = { menuItems, parseMenuId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.backdrawMenus = api;
})();
