/**
 * seismic.js — USGS Earthquake Feed
 *
 * USGS GeoJSON earthquake feed rendered as magnitude-scaled, colour-coded
 * ellipses on the globe.  Polls every 5 minutes.
 *
 * Feed: USGS all earthquakes — past 7 days
 *   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson
 *
 * Magnitude colour scale:
 *   M < 2.0  →  green   (micro, rarely felt)
 *   M < 4.0  →  yellow  (minor)
 *   M < 5.5  →  orange  (moderate)
 *   M < 7.0  →  red     (strong)
 *   M >= 7.0 →  crimson (major / great)
 */

import * as Cesium from 'cesium';
import { sparseSample } from '../detectMode.js';

const USGS_FEED =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson';

const POLL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Module state ─────────────────────────────────────────────────────────────

let _viewer      = null;
let _ds          = null;   // Cesium.CustomDataSource
let _hudEl       = null;
let _timer       = null;
let _lastGeoJson = null;
let _opacity     = 0.0;
let _fadeRaf     = null;

// ─── Colour / size helpers ────────────────────────────────────────────────────

function magColor(mag) {
  if (mag < 2.0) return Cesium.Color.fromCssColorString('#00cc44');
  if (mag < 4.0) return Cesium.Color.fromCssColorString('#dddd00');
  if (mag < 5.5) return Cesium.Color.fromCssColorString('#ff8800');
  if (mag < 7.0) return Cesium.Color.fromCssColorString('#ff2200');
  return          Cesium.Color.fromCssColorString('#cc0033');
}

function magRadius(mag) {
  return Math.max(8000, Math.pow(10, 0.55 * mag + 3.2));
}

// ─── Fade ─────────────────────────────────────────────────────────────────────

function _startFade(target, onDone) {
  if (_fadeRaf) { cancelAnimationFrame(_fadeRaf); _fadeRaf = null; }
  const from = _opacity;
  const t0 = performance.now();
  const DURATION = 400;
  const tick = () => {
    const t = Math.min((performance.now() - t0) / DURATION, 1.0);
    const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    _opacity = from + (target - from) * e;
    // No entity rebuild — CallbackProperty reads _opacity automatically each frame
    if (t < 1.0) {
      _fadeRaf = requestAnimationFrame(tick);
    } else {
      _opacity = target;
      _fadeRaf = null;
      if (onDone) onDone();
    }
  };
  _fadeRaf = requestAnimationFrame(tick);
}

// ─── Entity builder ───────────────────────────────────────────────────────────
// Entities are built once per data load. All animated colors use CallbackProperty
// so Cesium re-evaluates them every render frame, picking up the current _opacity.

function buildEntities(geojson) {
  if (!_ds) return;
  _lastGeoJson = geojson;
  _ds.entities.removeAll();

  const allFeatures = geojson.features ?? [];
  const features = sparseSample(
    allFeatures,
    f => f.geometry?.coordinates?.[1],
    f => f.geometry?.coordinates?.[0],
    5
  );

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords) continue;

    const [lon, lat, depthKm] = coords;
    const mag    = f.properties.mag   ?? 0;
    const place  = f.properties.place ?? 'Unknown location';
    const time   = new Date(f.properties.time).toISOString();
    const color  = magColor(mag);   // captured per-entity in closure
    const radius = magRadius(mag);

    _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),

      ellipse: {
        semiMajorAxis: radius,
        semiMinorAxis: radius,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => color.withAlpha(0.25 * _opacity), false)
        ),
        outline: true,
        outlineColor: new Cesium.CallbackProperty(
          () => color.withAlpha(0.6 * _opacity), false
        ),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },

      point: {
        pixelSize: Math.max(4, Math.round(mag * 2.5)),
        color: new Cesium.CallbackProperty(
          () => color.withAlpha(_opacity), false
        ),
        outlineColor: new Cesium.CallbackProperty(
          () => Cesium.Color.BLACK.withAlpha(0.6 * _opacity), false
        ),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },

      label: {
        text: `M${mag.toFixed(1)}`,
        font: '11px monospace',
        fillColor: new Cesium.CallbackProperty(
          () => color.withAlpha(_opacity), false
        ),
        outlineColor: new Cesium.CallbackProperty(
          () => Cesium.Color.BLACK.withAlpha(_opacity), false
        ),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(5e4, 1.0, 5e6, 0.0),
      },

      description:
        `<b>${place}</b><br>` +
        `Magnitude: ${mag}<br>` +
        `Depth: ${depthKm != null ? depthKm.toFixed(1) : '?'} km<br>` +
        `Time (UTC): ${time}`,
    });
  }

  updateHud(features.length);
  console.log(`[seismic] Rendered ${features.length}/${allFeatures.length} earthquakes`);
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

function updateHud(count) {
  if (!_hudEl) return;
  const now = new Date().toUTCString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, '$1');
  _hudEl.innerHTML =
    `<div class="sm-title">Seismic Activity</div>` +
    `<div class="sm-count">${count} events &mdash; past 7 days</div>` +
    `<div class="sm-updated">Updated ${now} UTC</div>` +
    `<div class="sm-legend">` +
      `<span style="color:#00cc44">M&lt;2</span> ` +
      `<span style="color:#dddd00">M&lt;4</span> ` +
      `<span style="color:#ff8800">M&lt;5.5</span> ` +
      `<span style="color:#ff2200">M&lt;7</span> ` +
      `<span style="color:#cc0033">M7+</span>` +
    `</div>`;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function load() {
  try {
    const res = await fetch(USGS_FEED);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    buildEntities(data);
  } catch (err) {
    console.error('[seismic] Fetch failed:', err);
  }
}

// ─── LayerModule interface ────────────────────────────────────────────────────

export const SeismicLayer = {
  id: 'seismic',
  label: 'Seismic  (USGS 7-day)',
  enabled: false,

  init(viewer) {
    _viewer = viewer;

    _ds = new Cesium.CustomDataSource('seismic');
    viewer.dataSources.add(_ds);
    window.addEventListener('ea:detectChange', () => {
      if (_lastGeoJson && _ds.show) buildEntities(_lastGeoJson);
    });

    // HUD element
    _hudEl = document.createElement('div');
    _hudEl.id = 'sm-hud';
    _hudEl.style.cssText = [
      'position:fixed',
      'bottom:100px',
      'right:20px',
      'background:rgba(24,0,0,0.88)',
      'border:1px solid #f44',
      'color:#f88',
      'font-family:monospace',
      'font-size:12px',
      'padding:8px 14px',
      'border-radius:4px',
      'pointer-events:none',
      'display:none',
      'z-index:1000',
      'min-width:210px',
      'letter-spacing:0.04em',
      'text-transform:uppercase',
      'line-height:1.6',
    ].join(';');
    document.body.appendChild(_hudEl);

    if (!document.getElementById('sm-hud-style')) {
      const s = document.createElement('style');
      s.id = 'sm-hud-style';
      s.textContent = `
        #sm-hud .sm-title   { color:#f44; font-size:10px; letter-spacing:0.12em; margin-bottom:2px; }
        #sm-hud .sm-count   { color:#fff; font-size:14px; font-weight:bold; }
        #sm-hud .sm-updated { color:#666; font-size:10px; }
        #sm-hud .sm-legend  { font-size:10px; margin-top:4px; border-top:1px solid #300; padding-top:4px; }
      `;
      document.head.appendChild(s);
    }
  },

  async enable(viewer) {
    _opacity = 0.0;
    _ds.show = true;
    if (_hudEl) _hudEl.style.display = 'block';
    await load();             // wait for data — entities built at opacity 0
    _startFade(1.0, null);    // fade in the moment entities exist
    _timer = setInterval(load, POLL_MS);
    console.log('[seismic] enabled — polling USGS feed every 5 minutes');
  },

  disable(viewer) {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _startFade(0.0, () => {
      _ds.show = false;
      _ds.entities.removeAll();
      if (_hudEl) _hudEl.style.display = 'none';
    });
  },

  refresh() {
    if (!_ds?.show) return;
    load();
  },
};

export default SeismicLayer;
