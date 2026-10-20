'use strict';
// Matching ChatGPT projects by name or link (pure; the host asks the extension for the list).

function normName(s) {
  return String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

function parseProjectUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^(www\.)?chatgpt\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/g\/(g-p-[0-9a-f]+)(-[^/]*)?(?:\/|$)/i);
  if (!m) return null;
  return { id: m[1], url: `https://chatgpt.com/g/${m[1]}${m[2] || ''}/project`, slug: (m[2] || '').slice(1) };
}

// Scores every project against the wanted name: 2 for the same normalized name, 1.5 when one
// contains the other, otherwise the edit-distance similarity (0-1). Best first; ties share the
// best score.
function rankProjects(projects, wantedName) {
  const wanted = normName(wantedName);
  const scored = projects.map(x => {
    const n = normName(x.name);
    const score = n === wanted ? 2 : n && (n.includes(wanted) || wanted.includes(n)) ? 1.5 : similarity(n, wanted);
    return { ...x, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0] || null;
  return { best, ties: best ? scored.filter(x => x.score === best.score) : [], scored };
}

// The project a name selects: the best match, if it scores at least 0.7 and no other project
// scores the same. Otherwise error is NOT_FOUND, or AMBIGUOUS with the tied projects.
function pickProject(projects, wantedName) {
  const { best, ties } = rankProjects(projects, wantedName);
  if (!best || best.score < 0.7) return { error: 'NOT_FOUND' };
  if (ties.length > 1) return { error: 'AMBIGUOUS', ties };
  return { project: best };
}

module.exports = { normName, similarity, parseProjectUrl, rankProjects, pickProject };
