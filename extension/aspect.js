// Centre-crop maths, shared by the service worker (importScripts: self.BackdrawAspect) and the
// Node tests (require). Pure and dependency-free, so loading it first in background.js can't fail.
(() => {
  const TOLERANCE = 0.01; // lib/aspect.js TOLERANCE

  // The largest rectangle of w:h centred in a width x height image ({x, y, width, height}, whole
  // pixels): the limiting side is kept whole and the other is rounded to the nearest pixel. null
  // when the image is already within tolerance of w:h, or too small to come any closer to it.
  function cropRect(width, height, w, h, tolerance = TOLERANCE) {
    if (!(width > 0 && height > 0 && w > 0 && h > 0)) return null;
    // |(width/height) / (w/h) - 1| <= tolerance, cross-multiplied so exactly 1% off still counts.
    if (Math.abs(width * h - height * w) <= tolerance * height * w) return null;
    // Not whole multiples of the reduced ratio: with terms up to 100 those can cut dozens of pixels
    // more than needed, from the side that should stay whole too, and beyond the band ChatGPT was told.
    const wide = width * h > height * w;
    const cw = wide ? Math.round((height * w) / h) : width;
    const ch = wide ? height : Math.round((width * h) / w);
    if (cw < 1 || ch < 1 || (cw === width && ch === height)) return null;
    return { x: Math.floor((width - cw) / 2), y: Math.floor((height - ch) / 2), width: cw, height: ch };
  }

  const api = { TOLERANCE, cropRect };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else self.BackdrawAspect = api;
})();
