const $ = id => document.getElementById(id);

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
    conn.textContent = 'Bağlı';
    conn.className = 'ok';
    $('hint').textContent = '';
  } else {
    conn.textContent = 'Bağlı değil';
    conn.className = 'bad';
    $('hint').textContent = `Yerel köprü bulunamadı${s && s.lastError ? ` (${s.lastError})` : ''}. Kurulum betiğini (install.js) çalıştırdığından emin ol.`;
  }
  $('project').textContent = s && s.project ? s.project.name : 'Seçilmedi';
  $('project').title = s && s.project ? s.project.url : '';
  $('job').textContent = s && s.current ? `${s.current.message || s.current.step} (${s.current.id})` : 'Boşta';

  const btn = $('pick');
  btn.hidden = true;
  if (!s || !s.connected) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const p = projectFromTab(tab);
  if (!p || (s.project && s.project.url === p.url)) return;
  btn.textContent = `“${p.name}” projesini kullan`;
  btn.hidden = false;
  btn.onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'popup:select', project: p });
    if (!r || !r.ok) $('hint').textContent = (r && r.error) || 'Seçilemedi.';
    setTimeout(render, 300);
  };
}

render();
