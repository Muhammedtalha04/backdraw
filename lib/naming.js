'use strict';
// File names for saved images: a local timestamp plus a short ASCII slug of the prompt, and the
// extension read from the image bytes themselves.

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slugify(s) {
  const tr = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
  const slug = s.replace(/[çğıöşüÇĞİÖŞÜ]/g, c => tr[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 48).replace(/-+$/, '');
  return slug || 'image';
}

function sniffExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  return null;
}

module.exports = { stamp, slugify, sniffExt };
