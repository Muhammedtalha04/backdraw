const $ = id => document.getElementById(id);
const { t } = i18n;

// A ChatGPT project page (or a chat inside a project) in the active tab can be picked directly.
function projectFromTab(tab) {
  const m = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-f]+)(-[^/?#]*)?(\/project)?/i.exec((tab && tab.url) || '');
  if (!m) return null;
  const fromTitle = m[3] ? String(tab.title || '').replace(/\s*[-|–]\s*ChatGPT\s*$/i, '').replace(/^ChatGPT\s*[-|–]\s*/i, '').trim() : '';
  return { url: `https://chatgpt.com/g/${m[1]}${m[2] || ''}/project`, name: fromTitle || (m[2] || '').slice(1) || m[1] };
}

async function render() {
  let s = null;
  try { s = await chrome.runtime.sendMessage({ type: 'popup:status' }); } catch {}
  $('ver').textContent = s ? s.version : '?';
  const conn = $('conn');
  if (s && s.connected) {
    conn.textContent = t('connected');
    conn.className = 'ok';
    $('hint').textContent = '';
  } else {
    conn.textContent = t('notConnected');
    conn.className = 'bad';
    $('hint').textContent = t('noHost', { error: s && s.lastError ? ` (${s.lastError})` : '' });
  }
  $('project').textContent = s && s.project ? s.project.name : t('notSelected');
  $('project').title = s && s.project ? s.project.url : '';
  $('job').textContent = s && s.current ? `${s.current.message || s.current.step} (${s.current.id})` : t('idle');

  const btn = $('pick');
  btn.hidden = true;
  if (!s || !s.connected) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const p = projectFromTab(tab);
  if (!p || (s.project && s.project.url === p.url)) return;
  btn.textContent = t('useProject', { name: p.name });
  btn.hidden = false;
  btn.onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'popup:select', project: p });
    if (!r || !r.ok) $('hint').textContent = (r && r.error) || t('selectFailed');
    setTimeout(render, 300);
  };
}

document.documentElement.lang = i18n.lang();
i18n.apply();
render();

// ---------------------------------------------------------------- reference collections

let openCol = null; // the collection shown in detail, or null for the list

async function hostCall(method, params = {}) {
  const r = await chrome.runtime.sendMessage({ type: 'host:call', method, params }).catch(e => ({ ok: false, error: e.message }));
  if (!r || !r.ok) throw new Error((r && r.error) || t('errNotConnected'));
  return r.result;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function colMessage(text, bad) {
  $('colMsg').textContent = text || '';
  $('colMsg').className = bad ? 'bad' : '';
}

async function showCollections(note, bad) {
  openCol = null;
  $('colDetail').hidden = true;
  $('colList').hidden = false;
  let list;
  try {
    list = await hostCall('list_collections', { summary: true });
  } catch (e) {
    $('colList').replaceChildren();
    return colMessage(e.message, true);
  }
  $('colList').replaceChildren(...list.map(c => el('button', { onclick: () => showCollection(c) },
    el('span', { textContent: c.name }), el('span', { className: 'count', textContent: i18n.images(c.count) }))));
  colMessage(note || (list.length ? '' : t('noCollections')), bad);
}

async function showCollection(c) {
  openCol = c;
  $('colList').hidden = true;
  $('colDetail').hidden = false;
  $('colEdit').hidden = true;
  $('colName').textContent = c.name;
  $('colPath').textContent = c.path || '';
  $('colGrid').replaceChildren();
  colMessage(t('loading'));
  try {
    // Thumbnails come a page at a time (each answer from the host has to stay under 1 MB).
    for (let offset = 0; offset !== null && openCol === c;) {
      const page = await hostCall('collection_thumbs', { name: c.name, offset });
      if (openCol !== c) return;
      $('colGrid').append(...page.thumbs.map(th => thumbTile(c, th)));
      offset = Number.isInteger(page.next) ? page.next : null;
    }
    colMessage('');
  } catch (e) {
    colMessage(e.message, true);
  }
}

// The first click on × arms it; a second one within 3 s deletes the file.
function thumbTile(c, th) {
  const pic = th.data ? el('img', { src: `data:${th.mime};base64,${th.data}`, alt: th.file, title: th.file })
    : el('div', { className: 'noimg', textContent: `${th.file} (${t('noThumb')})` });
  const del = el('button', { textContent: '×', title: t('removeImage') });
  const tile = el('div', { className: 'tile' }, pic, del);
  let armed = null;
  del.onclick = async () => {
    if (!armed) {
      del.classList.add('armed');
      del.title = t('confirmRemoveImage');
      armed = setTimeout(() => { armed = null; del.classList.remove('armed'); del.title = t('removeImage'); }, 3000);
      return;
    }
    clearTimeout(armed);
    del.disabled = true;
    try {
      const r = await hostCall('delete_collection_image', { name: c.name, file: th.file });
      c.count = r.count;
      tile.remove();
      colMessage('');
    } catch (e) {
      del.disabled = false;
      colMessage(e.message, true);
    }
  };
  return tile;
}

$('colBack').onclick = () => showCollections();

$('colRename').onclick = () => {
  const c = openCol;
  const input = el('input', { value: c.name });
  const save = el('button', { textContent: t('save') });
  const cancel = el('button', { textContent: t('cancel'), onclick: () => { $('colEdit').hidden = true; } });
  save.onclick = async () => {
    try {
      const r = await hostCall('rename_collection', { name: c.name, newName: input.value });
      Object.assign(c, { name: r.name, path: r.path });
      $('colName').textContent = r.name;
      $('colPath').textContent = r.path;
      $('colEdit').hidden = true;
      colMessage('');
    } catch (e) {
      colMessage(e.message, true);
    }
  };
  input.onkeydown = e => { if (e.key === 'Enter') save.click(); else if (e.key === 'Escape') cancel.click(); };
  $('colEdit').replaceChildren(input, save, cancel);
  $('colEdit').hidden = false;
  input.select();
};

$('colDelete').onclick = () => {
  const c = openCol;
  const yes = el('button', { className: 'danger', textContent: t('delete') });
  const no = el('button', { textContent: t('cancel'), onclick: () => { $('colEdit').hidden = true; } });
  yes.onclick = async () => {
    yes.disabled = true;
    try {
      const r = await hostCall('delete_collection', { name: c.name });
      const left = r.failed.length ? r.failed : r.left;
      showCollections(left.length ? t('leftover', { files: left.join(', ') }) : '', left.length > 0);
    } catch (e) {
      yes.disabled = false;
      colMessage(e.message, true);
    }
  };
  $('colEdit').replaceChildren(el('p', { textContent: t('confirmDelete', { name: c.name, images: i18n.images(c.count) }) }), yes, no);
  $('colEdit').hidden = false;
};

showCollections();
