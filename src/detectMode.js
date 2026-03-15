/**
 * detectMode.js — Global detection density toggle (Sparse / Full)
 *
 * Sparse: spatially sample items so you get an even global distribution
 *         without loading every single object.
 * Full:   no filtering, show everything.
 */

let _full = false;
const _listeners = new Set();

export function isFull()   { return _full; }
export function isSparse() { return !_full; }

export function setFull(val) {
  _full = !!val;
  for (const fn of _listeners) fn(_full);
}

export function onDetectChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Spatially downsample an array of items with lat/lon.
 * Keeps at most 1 item per grid cell, giving even global coverage.
 *
 * @param {Array}  items     - array of objects
 * @param {Function} getLat  - item => latitude
 * @param {Function} getLon  - item => longitude
 * @param {number} gridDeg   - cell size in degrees (bigger = fewer items)
 * @returns {Array} filtered subset
 */
export function sparseSample(items, getLat, getLon, gridDeg = 4) {
  if (_full) return items;
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const lat = getLat(item);
    const lon = getLon(item);
    if (lat == null || lon == null) continue;
    const key = `${Math.floor(lat / gridDeg)},${Math.floor(lon / gridDeg)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
