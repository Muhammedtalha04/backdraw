'use strict';
// Builds real PNG files for the tests: zlib-compressed rows and CRC-checked chunks.
const zlib = require('node:zlib');

// zlib.crc32 only exists since Node 20.15 / 22.2.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// A width x height, 8-bit PNG of the color type (all samples zero); `extra` chunks (PLTE, tRNS)
// go between IHDR and IDAT, `after` chunks between IDAT and IEND.
function png(colorType, { width = 4, height = 3, extra = [], after = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const rows = Buffer.alloc((1 + width * CHANNELS[colorType]) * height); // filter byte 0 per row
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(rows)), ...after, chunk('IEND')]);
}

module.exports = { crc32, chunk, png };
