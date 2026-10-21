// "New collection…" window: shows the image the user right-clicked and asks for the collection name.
// The service worker already downloads the image meanwhile and saves it when the name is given.
const $ = id => document.getElementById(id);
const key = location.hash.slice(1);
const { t } = i18n;
let names = [];

function show(text, bad) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'bad' : '';
}

async function ask(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, key, ...extra }).catch(e => ({ ok: false, error: e.message }));
  if (!r || !r.ok) throw new Error((r && r.error) || t('errNotConnected'));
  return r;
}

function cancel() {
  ask('collection:cancel').catch(() => {});
  window.close();
}

async function load() {
  i18n.apply();
  $('name').focus();
  try {
    const r = await ask('collection:pending');
    names = r.names || [];
    $('thumb').replaceChildren(Object.assign(document.createElement('img'), { src: `data:image/jpeg;base64,${r.thumb}`, alt: '' }));
    $('size').textContent = `${r.width} × ${r.height}`;
  } catch (e) {
    $('thumb').replaceChildren();
    $('add').disabled = true;
    show(e.message, true);
  }
}

$('name').addEventListener('input', () => {
  const wanted = $('name').value.replace(/\s+/g, ' ').trim().toLowerCase();
  show(wanted && names.some(n => n.toLowerCase() === wanted) ? t('nameExists') : '');
});

$('form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = $('name').value.replace(/\s+/g, ' ').trim();
  if (!name || Array.from(name).length > 64) return show(t('nameInvalid'), true);
  $('add').disabled = true;
  show(t('saving'));
  try {
    await ask('collection:create', { name });
    window.close(); // the page shows the result
  } catch (e) {
    show(e.message, true);
    $('add').disabled = false;
  }
});

$('cancel').addEventListener('click', cancel);
document.addEventListener('keydown', e => { if (e.key === 'Escape') cancel(); });
i18n.watch(() => i18n.apply());
backdrawSettings.ready.then(load); // in the language picked in the popup
