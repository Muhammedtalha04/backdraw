'use strict';
// Collection operations against temporary folders only; the real collections folder is never used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../lib/collection-store');
const c = require('../lib/collections');
const { MAX_REFS, MAX_REF_BYTES, MAX_COLLECTION_BYTES } = require('../lib/limits');

// A fresh root inside its own parent folder, so anything written next to the root would show up.
function tempRoot() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-col-'));
  test.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'References');
  return { parent, root };
}

const png = (extra = crypto.randomBytes(64)) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), extra]);
const jpeg = (extra = crypto.randomBytes(64)) => Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), extra]);
const b64 = buf => buf.toString('base64');
const at = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const manifest = (root, folder) => JSON.parse(fs.readFileSync(path.join(root, folder, 'collection.json'), 'utf8'));
const addPng = (root, collection, extra = {}, n = 0) => store.add(root, { collection, create: true, data: b64(png()), sourceUrl: 'https://example.com/a/Cat.png', ...extra }, at(n));
const code = c => e => e.code === c;

test('add: creates the collection with a host-made file name, a manifest and a thumbnail', () => {
  const { root } = tempRoot();
  const thumb = jpeg();
  const r = store.add(root, {
    collection: '  My Cats ', create: true, data: b64(png()), mime: 'image/png', thumb: b64(thumb), width: 640, height: 480,
    sourceUrl: 'https://cdn.example.com/x/Kedi%20Foto.png?w=1', pageUrl: 'https://example.com/page',
  }, at(1));
  assert.deepEqual(r, { name: 'My Cats', folder: 'My Cats', file: '001_kedi-foto.png', count: 1, created: true, duplicate: false });
  const m = manifest(root, 'My Cats');
  assert.equal(m.name, 'My Cats');
  assert.equal(m.createdAt, at(1).toISOString());
  assert.equal(m.images.length, 1);
  const [entry] = m.images;
  assert.deepEqual({ ...entry, sha256: undefined }, {
    file: '001_kedi-foto.png', sourceUrl: 'https://cdn.example.com/x/Kedi%20Foto.png?w=1', pageUrl: 'https://example.com/page',
    addedAt: at(1).toISOString(), bytes: fs.statSync(path.join(root, 'My Cats', '001_kedi-foto.png')).size, width: 640, height: 480, sha256: undefined,
  });
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'My Cats', 'thumbs', '001_kedi-foto.png.jpg')), thumb);
});

test('add: the extension comes from the bytes, not from the mime or the URL', () => {
  const { root } = tempRoot();
  const r = store.add(root, { collection: 'x', create: true, data: b64(jpeg()), mime: 'image/png', sourceUrl: 'https://e.com/pic.png' });
  assert.equal(r.file, '001_pic.jpg');
});

test('add: only png/jpeg/webp/gif bytes, at most 25 MB; bad input writes nothing', () => {
  const { parent, root } = tempRoot();
  const bad = [
    [{ data: b64(Buffer.from('<html><script>alert(1)</script></html>')), mime: 'image/png' }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.from('MZ\x90\x00 an executable, not an image at all')) }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.from([0x89, 0x50, 0x4e])) }, 'BAD_REQUEST'], // only the magic, nothing else
    // Two or three bytes that look like an image are not enough.
    [{ data: b64(Buffer.from('GIF<html><script>alert(1)</script></html>')) }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('#!/bin/sh\necho this is not a jpeg at all')])) }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e]), Buffer.from('G and then some text, no PNG')])) }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('no IHDR chunk follows here')])) }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.from('RIFF\x00\x00\x00\x00WEBPjunk that is not a VP8 chunk', 'latin1')) }, 'BAD_REQUEST'],
    [{ data: b64(Buffer.from('GIF8 but neither 87a nor 89a, just text')) }, 'BAD_REQUEST'],
    [{ data: '' }, 'BAD_REQUEST'],
    [{ data: 42 }, 'BAD_REQUEST'],
    [{}, 'BAD_REQUEST'],
    [{ data: 'A'.repeat(Math.ceil(MAX_COLLECTION_BYTES / 3) * 4 + 8) }, 'TOO_LARGE'],
    [{ data: b64(png(Buffer.alloc(MAX_COLLECTION_BYTES))) }, 'TOO_LARGE'],
  ];
  for (const [p, want] of bad) assert.throws(() => store.add(root, { collection: 'x', create: true, ...p }), code(want), JSON.stringify(p).slice(0, 80));
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('add: webp and gif are accepted by their magic bytes', () => {
  const { root } = tempRoot();
  const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'), crypto.randomBytes(40)]);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), crypto.randomBytes(40)]);
  assert.equal(store.add(root, { collection: 'x', create: true, data: b64(webp) }).file, '001_image.webp');
  assert.equal(store.add(root, { collection: 'x', data: b64(gif) }).file, '002_image.gif');
  const more = [['RIFF\x00\x00\x00\x00WEBPVP8L', 'webp'], ['RIFF\x00\x00\x00\x00WEBPVP8X', 'webp'], ['GIF87a', 'gif']];
  for (const [head, ext] of more) assert.match(store.add(root, { collection: 'x', data: b64(Buffer.concat([Buffer.from(head, 'latin1'), crypto.randomBytes(40)])) }).file, new RegExp(`\\.${ext}$`));
});

test('add: a thumbnail that is not a small JPEG is dropped, the image is still saved', () => {
  const { root } = tempRoot();
  store.add(root, { collection: 'x', create: true, data: b64(png()), thumb: b64(png()) });
  store.add(root, { collection: 'x', data: b64(png()), thumb: b64(jpeg(Buffer.alloc(300 * 1024))) });
  store.add(root, { collection: 'x', data: b64(png()), thumb: 'not base64 at all !!' });
  assert.equal(manifest(root, 'x').images.length, 3);
  assert.equal(fs.existsSync(path.join(root, 'x', 'thumbs')), false);
});

test('add: an unknown collection needs create; create reuses a name that differs only in case', () => {
  const { root } = tempRoot();
  assert.throws(() => store.add(root, { collection: 'Cats', data: b64(png()) }), code('NOT_FOUND'));
  addPng(root, 'Cats');
  const r = addPng(root, 'CATS');
  assert.equal(r.created, false);
  assert.equal(r.name, 'Cats');
  assert.equal(r.count, 2);
  assert.deepEqual(store.list(root).map(c => c.name), ['Cats']);
  assert.throws(() => store.add(root, { collection: '   ', create: true, data: b64(png()) }), code('BAD_REQUEST'));
  assert.throws(() => store.add(root, { collection: 'x'.repeat(65), create: true, data: b64(png()) }), code('BAD_REQUEST'));
});

test('add: the same bytes twice in one collection are kept once', () => {
  const { root } = tempRoot();
  const data = b64(png());
  store.add(root, { collection: 'x', create: true, data });
  const again = store.add(root, { collection: 'x', data });
  assert.deepEqual(again, { name: 'x', folder: 'x', file: '001_image.png', count: 1, created: false, duplicate: true });
  assert.deepEqual(fs.readdirSync(path.join(root, 'x')).sort(), ['001_image.png', 'collection.json']);
  // Another collection may hold the same picture.
  assert.equal(store.add(root, { collection: 'y', create: true, data }).duplicate, false);
});

test('add: traversal and device names in a collection name stay inside the root', () => {
  const { parent, root } = tempRoot();
  const cases = [['../../evil', 'evil'], ['..', 'collection'], ['..\\..\\Windows\\System32', 'WindowsSystem32'], ['CON', 'CON_'],
    ['a/b', 'ab'], ['C:\\temp', 'Ctemp'], ['🐉 refs', '🐉 refs'], ['x'.repeat(64), 'x'.repeat(64)]];
  for (const [name, folder] of cases) assert.equal(addPng(root, name).folder, folder, name);
  assert.deepEqual(fs.readdirSync(parent), ['References']);
  assert.deepEqual(fs.readdirSync(root).sort(), cases.map(([, f]) => f).sort());
  // The names themselves are kept as typed.
  assert.ok(store.list(root).some(c => c.name === '../../evil' && c.folder === 'evil'));
});

test('add: names that map to the same folder get numbered folders', () => {
  const { root } = tempRoot();
  assert.equal(addPng(root, 'ab').folder, 'ab');
  assert.equal(addPng(root, 'a/b').folder, 'ab 2');
  assert.equal(addPng(root, 'a\\b').folder, 'ab 3');
  const long = 'y'.repeat(63);
  assert.equal(addPng(root, long).folder, long);
  assert.equal(addPng(root, `${long}?`).folder, `${'y'.repeat(62)} 2`); // the number still fits in 64
  fs.mkdirSync(path.join(root, 'taken')); // a folder the user made by hand
  assert.equal(addPng(root, 'taken').folder, 'taken 2');
});

test('list: newest collection first, images newest first; hand-made or broken folders are skipped', () => {
  const { root } = tempRoot();
  addPng(root, 'old', {}, 1);
  addPng(root, 'new', {}, 2);
  addPng(root, 'old', { sourceUrl: 'https://e.com/second.png', pageUrl: 'https://site.example/p' }, 3);
  fs.mkdirSync(path.join(root, 'no manifest'));
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', 'collection.json'), '{ not json');
  fs.writeFileSync(path.join(root, 'stray.png'), png());
  const list = store.list(root);
  assert.deepEqual(list.map(c => c.name), ['old', 'new']);
  const [old] = list;
  assert.equal(old.count, 2);
  assert.equal(old.path, path.join(root, 'old'));
  assert.deepEqual(old.images.map(i => i.file), ['002_second.png', '001_cat.png']);
  assert.equal(old.images[0].path, path.join(root, 'old', '002_second.png'));
  assert.equal(old.images[0].pageUrl, 'https://site.example/p');
  assert.equal(old.updatedAt, at(3).toISOString());
  assert.deepEqual(store.list(path.join(root, 'missing')), []);
});

test('list: manifest entries that point outside the collection are ignored', () => {
  const { root } = tempRoot();
  addPng(root, 'x');
  const m = manifest(root, 'x');
  m.images.push({ file: '../../outside.png' }, { file: 'C:\\Windows\\win.ini' }, { file: '..' }, null, { file: 7 });
  fs.writeFileSync(path.join(root, 'x', 'collection.json'), JSON.stringify(m));
  const [col] = store.list(root);
  assert.deepEqual(col.images.map(i => i.file), ['001_cat.png']);
  assert.equal(col.count, 1);
});

test('data: URLs are not stored in full', () => {
  const { root } = tempRoot();
  addPng(root, 'x', { sourceUrl: `data:image/png;base64,${'A'.repeat(5000)}`, pageUrl: `https://e.com/${'p'.repeat(5000)}` });
  const [entry] = manifest(root, 'x').images;
  assert.equal(entry.sourceUrl, 'data:image/png;base64,');
  assert.equal(entry.pageUrl.length, 2048);
});

test('file numbers follow the highest one and never overwrite a file', () => {
  const { root } = tempRoot();
  addPng(root, 'x');
  addPng(root, 'x');
  store.removeImage(root, 'x', '001_cat.png');
  assert.equal(addPng(root, 'x').file, '003_cat.png');
  fs.writeFileSync(path.join(root, 'x', '004_cat.png'), 'a file the user put there');
  assert.equal(addPng(root, 'x').file, '005_cat.png');
  assert.equal(fs.readFileSync(path.join(root, 'x', '004_cat.png'), 'utf8'), 'a file the user put there');
});

test('find: loose for generating, exact or case-insensitive for changes; unknown names list the others', () => {
  const { root } = tempRoot();
  addPng(root, 'Dragon Refs');
  addPng(root, 'Cats');
  assert.equal(store.find(root, 'dragon-refs').name, 'Dragon Refs');
  assert.throws(() => store.find(root, 'dragon-refs', false), code('NOT_FOUND'));
  assert.equal(store.find(root, 'cats', false).name, 'Cats');
  assert.throws(() => store.find(root, 'dogs'), e => e.code === 'NOT_FOUND' && /Available collections: "Cats", "Dragon Refs"/.test(e.message));
  assert.throws(() => store.find(path.join(root, 'none'), 'x'), /Available collections: \(none\)/);
});

test('rename: folder and manifest; an existing name is refused', () => {
  const { root } = tempRoot();
  addPng(root, 'Cats', {}, 1);
  addPng(root, 'Dogs', {}, 2);
  const r = store.rename(root, 'cats', 'Kittens / 2026', at(3));
  assert.deepEqual(r, { name: 'Kittens / 2026', oldName: 'Cats', folder: 'Kittens 2026', path: path.join(root, 'Kittens 2026') });
  assert.ok(!fs.existsSync(path.join(root, 'Cats')));
  assert.equal(manifest(root, 'Kittens 2026').name, 'Kittens / 2026');
  assert.ok(fs.existsSync(path.join(root, 'Kittens 2026', '001_cat.png')));
  assert.throws(() => store.rename(root, 'Kittens / 2026', 'dogs'), code('EXISTS'));
  assert.throws(() => store.rename(root, 'Kittens / 2026', '  '), code('BAD_REQUEST'));
  assert.throws(() => store.rename(root, 'nope', 'x'), code('NOT_FOUND'));
  assert.equal(store.list(root)[0].name, 'Kittens / 2026'); // renaming counts as a change
});

test('rename: a change of case only renames in place; a taken folder gets a number', () => {
  const { root } = tempRoot();
  addPng(root, 'cats');
  assert.equal(store.rename(root, 'cats', 'Cats').folder, 'Cats');
  assert.deepEqual(fs.readdirSync(root), ['Cats']);
  fs.mkdirSync(path.join(root, 'Pets'));
  assert.equal(store.rename(root, 'Cats', 'Pets').folder, 'Pets 2');
  assert.equal(store.rename(root, 'Pets', '../../up').folder, 'up');
  assert.ok(fs.existsSync(path.join(root, 'up', 'collection.json')));
});

test('removeImage: deletes the file and its thumbnail; traversal names are refused', () => {
  const { parent, root } = tempRoot();
  addPng(root, 'x', { thumb: b64(jpeg()) });
  addPng(root, 'x', { thumb: b64(jpeg()) });
  fs.writeFileSync(path.join(parent, 'outside.png'), 'keep me');
  for (const file of ['../collection.json', '..\\collection.json', '../../outside.png', 'collection.json', '.', '..', 'thumbs', 'nope.png', '']) {
    assert.throws(() => store.removeImage(root, 'x', file), code('NOT_FOUND'), file);
  }
  assert.equal(fs.readFileSync(path.join(parent, 'outside.png'), 'utf8'), 'keep me');
  const r = store.removeImage(root, 'x', '001_cat.png');
  assert.deepEqual(r, { name: 'x', file: '001_cat.png', count: 1 });
  assert.deepEqual(fs.readdirSync(path.join(root, 'x')).sort(), ['002_cat.png', 'collection.json', 'thumbs']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'x', 'thumbs')), ['002_cat.png.jpg']);
  assert.deepEqual(manifest(root, 'x').images.map(i => i.file), ['002_cat.png']);
});

test('remove: deletes only what the collection wrote; anything else is left and reported', () => {
  const { parent, root } = tempRoot();
  addPng(root, 'x', { thumb: b64(jpeg()) });
  addPng(root, 'x');
  addPng(root, 'other');
  fs.writeFileSync(path.join(root, 'x', 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(parent, 'outside.png'), 'keep me');
  // A hand-edited manifest that points outside the collection.
  const m = manifest(root, 'x');
  m.images.push({ file: '../../outside.png' }, { file: '../other/001_cat.png' });
  fs.writeFileSync(path.join(root, 'x', 'collection.json'), JSON.stringify(m));
  const r = store.remove(root, 'x');
  assert.deepEqual(r, { name: 'x', folder: 'x', path: path.join(root, 'x'), deleted: 2, left: ['notes.txt'], failed: [] });
  assert.deepEqual(fs.readdirSync(path.join(root, 'x')), ['notes.txt']);
  assert.equal(fs.readFileSync(path.join(parent, 'outside.png'), 'utf8'), 'keep me');
  assert.ok(fs.existsSync(path.join(root, 'other', '001_cat.png')));
  assert.deepEqual(store.list(root).map(c => c.name), ['other']);
});

test('remove: a thumbnail that cannot be deleted is reported; its image still leaves the manifest', () => {
  const { root } = tempRoot();
  addPng(root, 'x', { thumb: b64(jpeg()) });
  addPng(root, 'x', { thumb: b64(jpeg()) });
  // A folder where the thumbnail was: unlinking it fails like a file a viewer holds open.
  const stuck = path.join(root, 'x', 'thumbs', '002_cat.png.jpg');
  fs.unlinkSync(stuck);
  fs.mkdirSync(stuck);
  fs.writeFileSync(path.join(stuck, 'inside'), 'x');
  const r = store.remove(root, 'x');
  assert.equal(r.deleted, 2);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /^thumbs\/002_cat\.png\.jpg \(\w+\)$/);
  assert.deepEqual(r.left, ['thumbs']);
  assert.ok(!fs.existsSync(path.join(root, 'x', 'collection.json')));
  assert.ok(!fs.existsSync(path.join(root, 'x', '002_cat.png')));
  assert.deepEqual(store.list(root), []);
});

test('remove: an empty collection folder goes away completely', () => {
  const { root } = tempRoot();
  addPng(root, 'x', { thumb: b64(jpeg()) });
  const r = store.remove(root, 'X');
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.left, []);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => store.remove(root, 'x'), code('NOT_FOUND'));
});

test('thumbs: newest first, a page within the budget; small originals stand in for missing thumbnails', () => {
  const { root } = tempRoot();
  const t1 = jpeg(Buffer.alloc(3000, 1));
  addPng(root, 'x', { thumb: b64(t1) }, 1);
  const small = png(Buffer.alloc(100, 2));
  store.add(root, { collection: 'x', data: b64(small) }, at(2));
  store.add(root, { collection: 'x', data: b64(png(Buffer.alloc(300 * 1024, 3))) }, at(3)); // too big to stand in
  const all = store.thumbs(root, 'x');
  assert.equal(all.total, 3);
  assert.equal(all.next, null);
  assert.deepEqual(all.thumbs.map(t => [t.file, t.mime]), [['003_image.png', null], ['002_image.png', 'image/png'], ['001_cat.png', 'image/jpeg']]);
  assert.equal(all.thumbs[0].data, null);
  assert.equal(all.thumbs[1].data, b64(small));
  assert.equal(all.thumbs[2].data, b64(t1));
  // A tiny budget: every page still holds at least one picture.
  const pages = [];
  for (let offset = 0; offset !== null;) {
    const page = store.thumbs(root, 'x', offset, 10);
    pages.push(page.thumbs.map(t => t.file));
    offset = page.next;
  }
  assert.deepEqual(pages, [['003_image.png'], ['002_image.png'], ['001_cat.png']]);
  assert.deepEqual(store.thumbs(root, 'x', 0, b64(small).length).thumbs.map(t => t.file), ['003_image.png', '002_image.png']);
  assert.deepEqual(store.thumbs(root, 'x', 99).thumbs, []);
  assert.equal(store.thumbs(root, 'x', 'junk').thumbs.length, 3);
  assert.ok(store.THUMB_PAGE < 1000000);
});

test('readImage: the bytes as a reference, with the mime from the bytes', () => {
  const { root } = tempRoot();
  const buf = jpeg();
  store.add(root, { collection: 'x', create: true, data: b64(buf) });
  const col = store.find(root, 'x');
  assert.deepEqual(store.readImage(root, col, col.images[0]), { name: '001_image.jpg', mime: 'image/jpeg', data: b64(buf) });
  fs.unlinkSync(col.images[0].path);
  assert.throws(() => store.readImage(root, col, col.images[0]), code('NOT_FOUND'));
  assert.throws(() => store.readImage(root, col, { file: '../../x.png' }), code('BAD_REQUEST'));
});

test('an image deleted by hand is not listed, counted or offered as a duplicate any more', () => {
  const { root } = tempRoot();
  addPng(root, 'Cats', { sourceUrl: 'https://e.com/a.png' }, 1);
  const data = b64(png());
  store.add(root, { collection: 'Cats', data, sourceUrl: 'https://e.com/b.png' }, at(2));
  fs.unlinkSync(path.join(root, 'Cats', '002_b.png'));
  const col = store.find(root, 'Cats');
  assert.equal(col.count, 1);
  assert.deepEqual(col.images.map(im => im.file), ['001_a.png']);
  assert.equal(store.thumbs(root, 'Cats').total, 1);
  // The same picture again is saved anew, under a new number.
  assert.deepEqual(store.add(root, { collection: 'Cats', data }, at(3)), { name: 'Cats', folder: 'Cats', file: '003_image.png', count: 2, created: false, duplicate: false });
});

// generate with reference_collection, against a temporary collections folder.
const io = root => ({ find: name => store.find(root, name), read: (col, im) => store.readImage(root, col, im) });
const own = n => Array.from({ length: n }, (_, i) => ({ name: `own${i}.png`, mime: 'image/png', data: b64(png()) }));
const plan = (root, p, limits) => c.withCollection({ prompt: 'x', ...p }, io(root), limits);
const addAbc = root => ['a', 'b', 'c'].forEach((n, i) => addPng(root, 'Cats', { sourceUrl: `https://e.com/${n}.png` }, i + 1));
const bad = re => e => e.code === 'BAD_REQUEST' && re.test(e.message);

test('withCollection: without reference_collection the request is unchanged; reference_files alone is refused', () => {
  const none = { find: () => assert.fail('find'), read: () => assert.fail('read') };
  const p = { prompt: 'x', references: own(1) };
  assert.deepEqual(c.withCollection(p, none), { params: p, collection: null });
  assert.throws(() => c.withCollection({ referenceFiles: ['001_a.png'] }, none), bad(/reference_files needs reference_collection/));
  assert.deepEqual(c.withCollection({ referenceFiles: [' ', ''] }, none).collection, null);
});

test('withCollection: own images first, then the newest of the collection; what was used is reported', () => {
  const { root } = tempRoot();
  addAbc(root);
  const mine = own(MAX_REFS - 2);
  const { params, collection } = plan(root, { references: mine, referenceCollection: 'cats' });
  assert.deepEqual(params.references.slice(0, mine.length), mine);
  assert.deepEqual(params.references.slice(mine.length).map(r => r.name), ['003_c.png', '002_b.png']);
  assert.equal(params.references.at(-1).data, fs.readFileSync(path.join(root, 'Cats', '002_b.png')).toString('base64'));
  assert.deepEqual(collection, { name: 'Cats', used: ['003_c.png', '002_b.png'], total: 3, skipped: [] });
  assert.equal(params.prompt, 'x');
});

test('withCollection: unknown collection, no free slot, empty collection', () => {
  const { root } = tempRoot();
  addPng(root, 'Cats');
  assert.throws(() => plan(root, { referenceCollection: 'dogs' }), bad(/Available collections: "Cats"/));
  assert.throws(() => plan(root, { referenceCollection: 'Cats', references: own(MAX_REFS) }), bad(new RegExp(`already use all ${MAX_REFS} reference slots`)));
  store.removeImage(root, 'Cats', '001_cat.png');
  assert.throws(() => plan(root, { referenceCollection: 'Cats' }), bad(/^Collection "Cats" has no images yet\.$/));
});

test('withCollection: reference_files picks in its order, counts a file once and names unknown files', () => {
  const { root } = tempRoot();
  addAbc(root);
  assert.deepEqual(plan(root, { referenceCollection: 'Cats', referenceFiles: ['001_a.png', 'C:\\x\\003_C.PNG'] }).collection.used, ['001_a.png', '003_c.png']);
  // The same file written three ways fits in one free slot.
  const one = plan(root, { referenceCollection: 'Cats', references: own(MAX_REFS - 1), referenceFiles: ['001_a.png', '001_A.png', 'dir/001_a.png'] });
  assert.deepEqual(one.collection.used, ['001_a.png']);
  assert.equal(one.params.references.length, MAX_REFS);
  assert.throws(() => plan(root, { referenceCollection: 'Cats', references: own(MAX_REFS - 1), referenceFiles: ['001_a.png', '002_b.png'] }),
    bad(/picks 2 images, but only 1 fit/));
  assert.throws(() => plan(root, { referenceCollection: 'Cats', referenceFiles: ['nope.png', '001_a.png'] }),
    bad(/has no "nope\.png"\. Its files \(newest first\): 003_c\.png, 002_b\.png, 001_a\.png$/));
  // A single file name as a string works too.
  assert.deepEqual(plan(root, { referenceCollection: 'Cats', referenceFiles: '002_b.png' }).collection.used, ['002_b.png']);
});

test('withCollection: images with the same (or no) date are picked in the order the list shows them', () => {
  const { root } = tempRoot();
  for (let i = 0; i < 3; i++) addPng(root, 'Cats', {}, 1);
  const newest = ['003_cat.png', '002_cat.png', '001_cat.png'];
  const check = () => {
    const col = store.find(root, 'Cats');
    assert.deepEqual(col.images.map(im => im.file), newest);
    assert.deepEqual(c.pickRefs(col.images, 2).used.map(im => im.file), newest.slice(0, 2));
    assert.deepEqual(plan(root, { referenceCollection: 'Cats', references: own(MAX_REFS - 1) }).collection.used, newest.slice(0, 1));
  };
  check();
  const m = manifest(root, 'Cats');
  for (const im of m.images) delete im.addedAt;
  fs.writeFileSync(path.join(root, 'Cats', 'collection.json'), JSON.stringify(m));
  check();
});

test('withCollection: a newest image that is too large, unreadable or deleted makes room for the next one', () => {
  const { root } = tempRoot();
  addPng(root, 'Cats', { sourceUrl: 'https://e.com/a.png' }, 1);
  store.add(root, { collection: 'Cats', data: b64(png(Buffer.alloc(500, 1))), sourceUrl: 'https://e.com/big.png' }, at(2));
  addPng(root, 'Cats', { sourceUrl: 'https://e.com/c.png' }, 3);
  addPng(root, 'Cats', { sourceUrl: 'https://e.com/d.png' }, 4);
  fs.unlinkSync(path.join(root, 'Cats', '004_d.png'));
  const limits = { maxBytes: 300 };
  const r = plan(root, { referenceCollection: 'Cats' }, limits);
  assert.deepEqual(r.collection.used, ['003_c.png', '001_a.png']);
  assert.equal(r.collection.total, 3);
  assert.deepEqual(r.collection.skipped.map(s => s.replace(/[\d.]+ MB/, 'N MB')), ['002_big.png (larger than N MB)']);
  // A picked image that is too large is refused by name.
  assert.throws(() => plan(root, { referenceCollection: 'Cats', referenceFiles: ['002_big.png'] }, limits), bad(/^"002_big\.png" in collection "Cats" is larger than/));
  // One that can't be read is left out too; picked, it is refused.
  const flaky = { ...io(root), read: (col, im) => (im.file === '003_c.png' ? assert.fail('EBUSY') : store.readImage(root, col, im)) };
  const f = c.withCollection({ referenceCollection: 'Cats' }, flaky, limits);
  assert.deepEqual(f.collection.used, ['001_a.png']);
  assert.equal(f.collection.skipped[0], '003_c.png (cannot be read)');
  assert.throws(() => c.withCollection({ referenceCollection: 'Cats', referenceFiles: ['003_c.png'] }, flaky, limits), bad(/EBUSY/));
  // Nothing usable at all.
  assert.throws(() => c.withCollection({ referenceCollection: 'Cats' }, flaky, { maxBytes: 10 }), bad(/^No image of collection "Cats" can be attached: 003_c\.png \(cannot be read\), 002_big\.png/));
});

test('withCollection: an image between the reference and the collection limit stays in the collection, out of the job', () => {
  const { root } = tempRoot();
  addPng(root, 'Cats', { sourceUrl: 'https://e.com/a.png' }, 1);
  store.add(root, { collection: 'Cats', data: b64(png(Buffer.alloc(MAX_REF_BYTES + 1024))), sourceUrl: 'https://e.com/big.png' }, at(2));
  assert.ok(MAX_REF_BYTES < MAX_COLLECTION_BYTES);
  const r = plan(root, { referenceCollection: 'cats' });
  assert.deepEqual(r.collection.used, ['001_a.png']);
  assert.deepEqual(r.collection.skipped, [`002_big.png (larger than ${MAX_REF_BYTES / 1048576} MB)`]);
});

test('withCollection: the references together stay within the total limit', () => {
  const { root } = tempRoot();
  addAbc(root); // 80 bytes each
  const limits = { maxTotal: 200 };
  const r = plan(root, { referenceCollection: 'Cats' }, limits);
  assert.deepEqual(r.collection.used, ['003_c.png', '002_b.png']);
  assert.match(r.collection.skipped[0], /^001_a\.png \(all references together would pass [\d.]+ MB\)$/);
  assert.deepEqual(plan(root, { referenceCollection: 'Cats', references: own(1) }, limits).collection.used, ['003_c.png']);
  const big = [{ name: 'big.png', mime: 'image/png', data: b64(png(Buffer.alloc(300))) }];
  assert.throws(() => plan(root, { referenceCollection: 'Cats', references: big }, limits), bad(/reference_images together already reach/));
  assert.throws(() => plan(root, { referenceCollection: 'Cats', referenceFiles: ['001_a.png', '002_b.png', '003_c.png'] }, limits),
    bad(/picked images and reference_images together are larger than/));
});
