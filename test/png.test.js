'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { pngInfo } = require('../lib/png');
const { sniffExt } = require('../lib/naming');
const { crc32, chunk, png } = require('./png-fixture');

const PLTE = chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]));

test('the test PNGs are well-formed', () => {
  const file = png(6);
  assert.equal(sniffExt(file), 'png');
  // Every chunk's CRC matches, and the image data inflates to the expected rows.
  let pos = 8;
  const types = [];
  while (pos < file.length) {
    const len = file.readUInt32BE(pos);
    const type = file.toString('latin1', pos + 4, pos + 8);
    assert.equal(file.readUInt32BE(pos + 8 + len), crc32(file.subarray(pos + 4, pos + 8 + len)), type);
    if (type === 'IDAT') assert.equal(zlib.inflateSync(file.subarray(pos + 8, pos + 8 + len)).length, 3 * (1 + 4 * 4));
    types.push(type);
    pos += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082); // the well-known IEND CRC
});

test('RGBA: alpha channel', () => {
  assert.deepEqual(pngInfo(png(6, { width: 1254, height: 1254 })), { width: 1254, height: 1254, bitDepth: 8, colorType: 6, alphaChannel: true, trns: false });
});

test('RGB: no alpha channel', () => {
  assert.deepEqual(pngInfo(png(2, { width: 1672, height: 941 })), { width: 1672, height: 941, bitDepth: 8, colorType: 2, alphaChannel: false, trns: false });
});

test('grayscale with and without alpha', () => {
  assert.equal(pngInfo(png(4)).alphaChannel, true);
  assert.equal(pngInfo(png(4)).colorType, 4);
  assert.equal(pngInfo(png(0)).alphaChannel, false);
});

test('palette: transparent only with a tRNS chunk', () => {
  assert.deepEqual(pngInfo(png(3, { extra: [PLTE, chunk('tRNS', Buffer.from([0]))] })), { width: 4, height: 3, bitDepth: 8, colorType: 3, alphaChannel: false, trns: true });
  assert.equal(pngInfo(png(3, { extra: [PLTE] })).trns, false);
});

test('RGB with tRNS (one transparent color)', () => {
  const info = pngInfo(png(2, { extra: [chunk('tEXt', Buffer.from('Software\0test')), chunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0]))] }));
  assert.equal(info.alphaChannel, false);
  assert.equal(info.trns, true);
});

test('a tRNS after the image data is not one (the scan stops at IDAT)', () => {
  assert.equal(pngInfo(png(2, { after: [chunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0]))] })).trns, false);
});

test('not a PNG', () => {
  assert.equal(pngInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(40)])), null);
  assert.equal(pngInfo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(30)])), null);
  assert.equal(pngInfo(Buffer.alloc(0)), null);
  assert.equal(pngInfo('not a buffer'), null);
  assert.equal(pngInfo(null), null);
  // A PNG signature whose first chunk is not IHDR.
  const broken = Buffer.from(png(6));
  broken.write('IDAT', 12, 'latin1');
  assert.equal(pngInfo(broken), null);
});

test('truncated buffers never throw', () => {
  const file = png(3, { extra: [PLTE, chunk('tRNS', Buffer.from([0]))] });
  for (let n = 0; n <= file.length; n++) {
    const info = pngInfo(file.subarray(0, n));
    if (n < 29) assert.equal(info, null, `${n} bytes`);
    else assert.equal(info.colorType, 3, `${n} bytes`);
  }
  // The tRNS chunk header starts after IHDR (33 bytes) and PLTE (12 + 6): with it the flag is set.
  const trnsAt = 33 + 18;
  assert.equal(pngInfo(file.subarray(0, trnsAt + 7)).trns, false);
  assert.equal(pngInfo(file.subarray(0, trnsAt + 8)).trns, true);
  // A chunk that claims to be longer than the file ends the scan.
  const huge = Buffer.from(png(2, { extra: [chunk('tEXt', Buffer.from('a'))] }));
  huge.writeUInt32BE(0xffffffff, 33);
  assert.equal(pngInfo(huge).trns, false);
});
