'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { normName, similarity, parseProjectUrl, rankProjects, pickProject } = require('../lib/projects');

const HEX = '67a1b2c3d4e5f60718293a4b5c6d7e8f';
const ID = `g-p-${HEX}`;
const CHAT = '6812a3b4-1c2d-8000-9e8f-0123456789ab';
const project = (slug = '-claude-images') => ({ id: ID, url: `https://chatgpt.com/g/${ID}${slug}/project`, slug: slug.slice(1) });

test('parseProjectUrl: project link with a name', () => {
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}-claude-images/project`), project());
});

test('parseProjectUrl: link without the name part', () => {
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}/project`), project(''));
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}`), project(''));
});

test('parseProjectUrl: link without /project gets it added', () => {
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}-claude-images`), project());
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}-claude-images/`), project());
});

test('parseProjectUrl: a chat inside a project gives the project', () => {
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}-claude-images/c/${CHAT}`), project());
});

test('parseProjectUrl: www, query and hash are normalized away', () => {
  assert.deepEqual(parseProjectUrl(`https://www.chatgpt.com/g/${ID}-claude-images/project`), project());
  assert.deepEqual(parseProjectUrl(`https://chatgpt.com/g/${ID}-claude-images/project?model=gpt-4o#top`), project());
});

test('parseProjectUrl: current behavior for http and upper case (accepted, rebuilt as https)', () => {
  const upper = `g-p-${HEX.toUpperCase()}`;
  assert.deepEqual(parseProjectUrl(`http://ChatGPT.com/g/${upper}-X/project`),
    { id: upper, url: `https://chatgpt.com/g/${upper}-X/project`, slug: 'X' });
});

test('parseProjectUrl: anything that is not a chatgpt.com project is null', () => {
  assert.equal(parseProjectUrl(`https://chat.openai.com/g/${ID}-claude-images/project`), null);
  assert.equal(parseProjectUrl(`https://evilchatgpt.com/g/${ID}-x/project`), null);
  assert.equal(parseProjectUrl('https://chatgpt.com/g/g-abc123XYZ-my-gpt'), null); // a custom GPT, not g-p-
  assert.equal(parseProjectUrl(`https://chatgpt.com/c/${CHAT}`), null);
  assert.equal(parseProjectUrl('https://chatgpt.com/'), null);
  assert.equal(parseProjectUrl('not a url'), null);
  assert.equal(parseProjectUrl(`chatgpt.com/g/${ID}-x/project`), null);
  assert.equal(parseProjectUrl(''), null);
  assert.equal(parseProjectUrl(undefined), null);
  assert.equal(parseProjectUrl(null), null);
});

test('normName: case, spaces, accents and Turkish letters fold to the same key', () => {
  assert.equal(normName('ÇizimGörselleri'), 'cizimgorselleri');
  assert.equal(normName('çizim görselleri'), 'cizimgorselleri');
  assert.equal(normName('CIZIMGORSELLERI'), 'cizimgorselleri');
  assert.equal(normName('ÇİZİM GÖRSELİ'), 'cizimgorseli');
  // Turkish lower-casing turns I into dotless ı; it still folds to i.
  assert.equal(normName('IMAGES'), 'images');
  assert.equal(normName('İstanbul'), 'istanbul');
  assert.equal(normName('Işık'), 'isik');
  assert.equal(normName('  Café – Art! '), 'cafeart');
  assert.equal(normName(null), '');
  assert.equal(normName(undefined), '');
});

test('similarity: 1 for equal, 0 for empty, edit distance in between', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('', 'abc'), 0);
  assert.equal(similarity('abc', ''), 0);
  assert.equal(similarity('abcd', 'abce'), 0.75);
  assert.equal(similarity('kitten', 'sitting'), 1 - 3 / 7);
  assert.equal(similarity('ab', 'ba'), similarity('ba', 'ab'));
});

test('rankProjects: an exact (normalized) name wins over a substring match', () => {
  const r = rankProjects([{ name: 'Claude' }, { name: 'Claude Çizimler', url: 'u' }, { name: 'Work' }], 'claude cizimler');
  assert.deepEqual(r.best, { name: 'Claude Çizimler', url: 'u', score: 2 });
  assert.equal(r.ties.length, 1);
  assert.deepEqual(r.scored.map(x => [x.name, x.score > 1 ? x.score : 'fuzzy']), [['Claude Çizimler', 2], ['Claude', 1.5], ['Work', 'fuzzy']]);
});

test('rankProjects: substring either way scores 1.5', () => {
  assert.equal(rankProjects([{ name: 'Claude Çizimler' }], 'çizim').best.score, 1.5);
  assert.equal(rankProjects([{ name: 'Art' }], 'concept art').best.score, 1.5);
});

test('rankProjects: otherwise the edit-distance similarity', () => {
  const r = rankProjects([{ name: 'Work' }, { name: 'Concept Art' }], 'concpet art');
  assert.equal(r.best.name, 'Concept Art');
  assert.equal(r.best.score, similarity('conceptart', 'concpetart'));
  assert.ok(r.best.score >= 0.7 && r.best.score < 1);
  assert.ok(r.scored[1].score < 0.7);
});

test('rankProjects: equal best scores are reported as ties', () => {
  const r = rankProjects([{ name: 'Images A' }, { name: 'Images B' }, { name: 'Other' }], 'images');
  assert.deepEqual(r.ties.map(x => x.name), ['Images A', 'Images B']);
});

test('rankProjects: an empty list has no best match', () => {
  assert.deepEqual(rankProjects([], 'x'), { best: null, ties: [], scored: [] });
});

test('rankProjects: a project without a name never matches by substring', () => {
  assert.equal(rankProjects([{ name: '' }], 'images').best.score, 0);
});

test('pickProject: a fuzzy match of exactly 0.7 is accepted', () => {
  assert.equal(similarity('abcdefghij', 'abcdefgxyz'), 0.7);
  assert.deepEqual(pickProject([{ name: 'abcdefgxyz', url: 'u' }, { name: 'Work' }], 'abcdefghij'), { project: { name: 'abcdefgxyz', url: 'u', score: 0.7 } });
});

test('pickProject: just under 0.7 is NOT_FOUND', () => {
  const score = similarity('abcdefghijklm', 'abcdefghiwxyz');
  assert.ok(score > 0.69 && score < 0.7);
  assert.deepEqual(pickProject([{ name: 'abcdefghiwxyz' }], 'abcdefghijklm'), { error: 'NOT_FOUND' });
});

test('pickProject: equal best scores are AMBIGUOUS, with the tied projects', () => {
  const r = pickProject([{ name: 'Images A' }, { name: 'Images B' }, { name: 'Other' }], 'images');
  assert.equal(r.error, 'AMBIGUOUS');
  assert.deepEqual(r.ties.map(x => [x.name, x.score]), [['Images A', 1.5], ['Images B', 1.5]]);
  assert.equal(r.project, undefined);
});

test('pickProject: an exact name beats substring matches; an empty list is NOT_FOUND', () => {
  assert.equal(pickProject([{ name: 'Images A' }, { name: 'Images' }], 'images').project.name, 'Images');
  assert.deepEqual(pickProject([], 'images'), { error: 'NOT_FOUND' });
});
