'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildText } = require('../lib/prompt');

const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f-images/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';
const PROJECT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f-images/project';
const ref = name => ({ name, bytes: 1000 });

test('send_as_is: the prompt goes out verbatim, whatever else is set', () => {
  assert.equal(buildText({ prompt: 'Yes, 16:9 please.', sendAsIs: true }), 'Yes, 16:9 please.');
  assert.equal(buildText({ prompt: 'p', sendAsIs: true, references: [ref('a.png')], startUrl: CHAT_URL }), 'p');
});

test('one reference image', () => {
  const text = buildText({ prompt: 'Close the eyes.', references: [ref('a.png')] });
  assert.match(text, /^The attached image is the reference\. /);
  assert.match(text, /change only what is asked and keep everything else identical/);
  assert.match(text, /Don't ask follow-up questions; generate the image directly\.\n\nClose the eyes\.$/);
});

test('several reference images', () => {
  const text = buildText({ prompt: 'Same character, bust sprite.', references: [ref('a.png'), ref('b.png')] });
  assert.match(text, /^The attached images are references\. /);
  assert.ok(text.endsWith('\n\nSame character, bust sprite.'));
});

test('references win over continuing a chat', () => {
  assert.match(buildText({ prompt: 'p', references: [ref('a.png')], startUrl: CHAT_URL }), /^The attached image is the reference/);
});

test('continuing a chat (/c/<id>) asks for an updated image', () => {
  assert.equal(buildText({ prompt: 'Make it night.', startUrl: CHAT_URL, references: [] }),
    'Update the image with the changes below and generate the new image directly, without follow-up questions.\n\nMake it night.');
});

test('a project link without a chat is a new image', () => {
  assert.match(buildText({ prompt: 'p', startUrl: PROJECT_URL }), /^Generate an image from the description below\./);
});

test('plain new image', () => {
  assert.equal(buildText({ prompt: 'A void mage.' }),
    "Generate an image from the description below. Don't ask follow-up questions; create the image directly.\n\nA void mage.");
  assert.equal(buildText({ prompt: 'A void mage.', references: [], startUrl: null }), buildText({ prompt: 'A void mage.' }));
});
