'use strict';
// PNG header facts (pure): whether ChatGPT's file can hold transparency at all. The pixels
// themselves are measured by the extension; this only reads IHDR and looks for a tRNS chunk.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// null unless buf starts with a complete PNG signature and IHDR. Color types 4 (gray+alpha) and 6
// (RGBA) have an alpha channel; tRNS gives the others transparent colors. tRNS must come before
// the first IDAT, so the scan stops there (or at a truncated chunk).
function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 29 ||!buf.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buf.readUInt32BE(8) < 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const colorType = buf[25];
  let trns = false;
  for (let pos = 8; pos + 8 <= buf.length;) {
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'tRNS') { trns = true; break; }
    if (type === 'IDAT' || type === 'IEND') break;
    pos += 12 + buf.readUInt32BE(pos);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType, alphaChannel: colorType === 4 || colorType === 6, trns };
}

module.exports = { pngInfo };
