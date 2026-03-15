/**
 * satellites.js — Real-Time Satellite Tracking
 *
 * Fetches TLE (Two-Line Element) data from SatNOGS, propagates orbits via
 * satellite.js SGP4, and renders diamond icons color-coded by country of origin.
 * Click a satellite to draw its orbit arc and show a reticle.
 *
 * Data:    SatNOGS TLE open DB (public, no key required)
 *          https://db.satnogs.org/api/tle/?format=json&limit=2000
 * Render:  BillboardCollection — diamond icons, color-coded by country of origin
 * Update:  Propagate every 2s via satellite.js SGP4
 * Click:   Draw full orbit arc, log NORAD ID
 *
 * Conflict Monitor additions:
 *   - Country classification: China=red, Russia=yellow, USA mil=blue, NATO=cyan, commercial=white
 *   - Diamond icon shape per country (replaces dot + brackets)
 *   - Actual satellite names in labels (not SAT-XXXXX)
 *   - Nadir lines from nearby satellites to the active conflict target point
 *   - Responds to ea:conflict:activated / ea:conflict:deactivated / ea:conflict:target-changed
 *
 * Reference images (Agent 4):
 *   Satellite_Survelance/Labeled_Country_Staeallites_REDforCHINA_YELLOW_FORrussia_BLUEforNATO_.png
 *   Satellite_Survelance/Satellites_withLines.png
 *   Satellite_Survelance/Satellites_withLines2.png
 */

import * as Cesium from 'cesium';
import * as satellite from 'satellite.js';
import { isFull } from '../detectMode.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const TLE_URL       = 'https://db.satnogs.org/api/tle/?format=json&limit=2000';
const UPDATE_MS     = 2000;
const ORBIT_SAMPLES = 120;
const ORBIT_COLOR   = new Cesium.Color(1.0, 0.9, 0.0, 0.9);
const ORBIT_WIDTH   = 2.0;

// Nadir line threshold: only draw lines for sats within this distance (meters) of target
const NADIR_DIST_THRESHOLD = 2_500_000; // 2500km

// ─── Country Classification ───────────────────────────────────────────────────

// Order matters — first match wins
const COUNTRY_CLASSIFIERS = [
  {
    pattern:  /gaofen|yaogan|shijian|tianhui|ziyuan|haiyang|fengyun|beidou|jilin/i,
    country:  'china',
    color:    new Cesium.Color(1.0, 0.2, 0.2, 1.0),       // red
  },
  {
    pattern:  /cosmos|resurs|kondor|canopus|persona|lotos|gonets|glonass|meridian/i,
    country:  'russia',
    color:    new Cesium.Color(1.0, 0.85, 0.0, 1.0),      // yellow
  },
  {
    pattern:  /usa-|topaz|lacrosse|keyhole|nro|wgs|aehf|muos|sbirs/i,
    country:  'usa_mil',
    color:    new Cesium.Color(0.3, 0.7, 1.0, 1.0),       // blue
  },
  {
    pattern:  /pleiades|spot|sentinel|helios|rapid.?eye|worldview|geoeye|maxar|capella/i,
    country:  'nato',
    color:    new Cesium.Color(0.4, 0.9, 1.0, 1.0),       // cyan
  },
  {
    pattern:  null,
    country:  'commercial',
    color:    new Cesium.Color(0.8, 0.85, 1.0, 0.75),     // dim white-blue
  },
];

function classifySatellite(name) {
  for (const c of COUNTRY_CLASSIFIERS) {
    if (c.pattern && c.pattern.test(name)) return c;
  }
  return COUNTRY_CLASSIFIERS[COUNTRY_CLASSIFIERS.length - 1];
}

// ─── Diamond Icon (per country color, cached) ─────────────────────────────────

const _iconCache = {};

function buildCountryIcon(color) {
  const key = color.toCssColorString();
  if (_iconCache[key]) return _iconCache[key];

  const sz   = 28;
  const c    = document.createElement('canvas');
  c.width    = c.height = sz;
  const ctx  = c.getContext('2d');
  const half = sz / 2;

  // Diamond outline
  ctx.strokeStyle = color.toCssColorString();
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(half, 3);       // top
  ctx.lineTo(sz - 3, half);  // right
  ctx.lineTo(half, sz - 3);  // bottom
  ctx.lineTo(3, half);       // left
  ctx.closePath();
  ctx.stroke();

  // Faint fill
  ctx.fillStyle = color.withAlpha(0.15).toCssColorString();
  ctx.fill();

  // Center dot
  ctx.fillStyle = color.withAlpha(0.9).toCssColorString();
  ctx.beginPath();
  ctx.arc(half, half, 2, 0, Math.PI * 2);
  ctx.fill();

  _iconCache[key] = c.toDataURL();
  return _iconCache[key];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSatnogsJSON(records) {
  const sats = [];
  for (const r of records) {
    const tle1 = r.tle1 || r.line1;
    const tle2 = r.tle2 || r.line2;
    const name = (r.tle0 || r.name || '').replace(/^0 /, '').trim();
    if (!tle1 || !tle2) continue;
    try {
      const satrec = satellite.twoline2satrec(tle1, tle2);
      sats.push({ name, satrec, noradId: r.norad_cat_id || satrec.satnum });
    } catch {
      // skip bad record
    }
  }
  return sats;
}

function propagateSat(satrec, date) {
  try {
    const { position } = satellite.propagate(satrec, date);
    if (!position || typeof position === 'boolean') return null;
    const gmst = satellite.gstime(date);
    const geo  = satellite.eciToGeodetic(position, gmst);
    return Cesium.Cartesian3.fromRadians(geo.longitude, geo.latitude, geo.height * 1000);
  } catch {
    return null;
  }
}

function buildOrbitPositions(satrec, now) {
  const periodMs = (2 * Math.PI / satrec.no) * 60 * 1000;
  const stepMs   = periodMs / ORBIT_SAMPLES;
  const positions = [];
  for (let i = 0; i <= ORBIT_SAMPLES; i++) {
    const t   = new Date(now.getTime() + i * stepMs);
    const pos = propagateSat(satrec, t);
    if (pos) positions.push(pos);
  }
  return positions;
}

// ─── Reticle canvas (targeting crosshair for selected sat) ────────────────────

let _reticleCanvas = null;
function _buildReticleCanvas() {
  if (_reticleCanvas) return _reticleCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#ffdd00';
  ctx.lineWidth = 1.5;
  const m = 4, s = 10;
  [[m,m],[38,m],[m,38],[38,38]].forEach(([x,y]) => {
    const dx = x < 24 ? s : -s, dy = y < 24 ? s : -s;
    ctx.beginPath(); ctx.moveTo(x+dx,y); ctx.lineTo(x,y); ctx.lineTo(x,y+dy); ctx.stroke();
  });
  ctx.fillStyle = '#ffdd00';
  ctx.beginPath(); ctx.arc(24,24,2,0,Math.PI*2); ctx.fill();
  _reticleCanvas = c;
  return c;
}

// ─── Layer Module ─────────────────────────────────────────────────────────────

export const SatellitesLayer = {
  id:      'satellites',
  label:   'Satellites',
  enabled: false,

  // Internal state
  _sats:           [],
  _icons:          null,  // BillboardCollection
  _labels:         null,  // LabelCollection
  _orbitEntity:    null,
  _reticleEntity:  null,
  _selectedSatrec: null,
  _selectedName:   null,
  _intervalId:     null,
  _clickHandler:   null,
  _viewer:         null,
  _labelsVisible:  false,

  // Conflict Monitor state
  _nadirLines:     [],    // Cesium entity references for active nadir lines
  _nadirTarget:    null,  // { lat, lon } | null

  // Fade transition
  _opacity:        0.0,
  _fadeRaf:        null,
  _lastRenderItems: [], // cached {pos, iconUrl, name, cls} for per-frame opacity redraw
  _labelOpacity:   0.0,
  _labelFadeRaf:   null,
  _detectOpacity:  1.0,
  _detectFadeRaf:  null,

  // ── LayerModule interface ──────────────────────────────────────────────────

  init(viewer) {
    this._viewer = viewer;
    this._icons  = new Cesium.BillboardCollection({ scene: viewer.scene });
    this._labels = new Cesium.LabelCollection();
    viewer.scene.primitives.add(this._icons);
    viewer.scene.primitives.add(this._labels);
    this._icons.show  = false;
    this._labels.show = false;

    // Conflict Monitor event listeners
    window.addEventListener('ea:detectPre', () => {
      if (this._icons.show) this._startDetectFade(0.0);
    });
    window.addEventListener('ea:detectChange', () => {
      if (!this._icons.show) return;
      this._detectOpacity = 0.0;
      this._tick();
      this._startDetectFade(1.0);
    });

    window.addEventListener('ea:conflict:activated', () => {
      // Default nadir target: Tehran
      this._nadirTarget = { lat: 35.7, lon: 51.4 };
    });

    window.addEventListener('ea:conflict:deactivated', () => {
      this._nadirTarget = null;
      this._clearNadirLines();
    });

    window.addEventListener('ea:conflict:target-changed', (e) => {
      const { lat, lon } = e.detail;
      this._nadirTarget = { lat, lon };
    });
  },

  setLabels(visible) {
    this._labelsVisible = visible;
    if (!this.enabled) return;
    if (visible) {
      this._labels.show = true;
      this._startLabelFade(1.0);
    } else {
      this._startLabelFade(0.0);
    }
  },

  _startDetectFade(target) {
    if (this._detectFadeRaf) { cancelAnimationFrame(this._detectFadeRaf); this._detectFadeRaf = null; }
    const from = this._detectOpacity;
    const t0 = performance.now();
    const DURATION = 250;
    const tick = () => {
      const t = Math.min((performance.now() - t0) / DURATION, 1.0);
      const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      this._detectOpacity = from + (target - from) * e;
      this._redrawOpacity();
      if (t < 1.0) {
        this._detectFadeRaf = requestAnimationFrame(tick);
      } else {
        this._detectOpacity = target;
        this._detectFadeRaf = null;
      }
    };
    this._detectFadeRaf = requestAnimationFrame(tick);
  },

  _startLabelFade(target) {
    if (this._labelFadeRaf) { cancelAnimationFrame(this._labelFadeRaf); this._labelFadeRaf = null; }
    const from = this._labelOpacity;
    const t0 = performance.now();
    const DURATION = 400;
    const tick = () => {
      const t = Math.min((performance.now() - t0) / DURATION, 1.0);
      const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      this._labelOpacity = from + (target - from) * e;
      this._redrawOpacity();
      if (t < 1.0) {
        this._labelFadeRaf = requestAnimationFrame(tick);
      } else {
        this._labelOpacity = target;
        this._labelFadeRaf = null;
        if (target === 0.0) this._labels.show = false;
      }
    };
    this._labelFadeRaf = requestAnimationFrame(tick);
  },

  setNadirTarget(lat, lon) {
    this._nadirTarget = { lat, lon };
  },

  _startFade(target, onDone) {
    if (this._fadeRaf) { cancelAnimationFrame(this._fadeRaf); this._fadeRaf = null; }
    const from = this._opacity;
    const t0 = performance.now();
    const DURATION = 400;
    const tick = () => {
      const t = Math.min((performance.now() - t0) / DURATION, 1.0);
      const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      this._opacity = from + (target - from) * e;
      this._redrawOpacity();
      if (t < 1.0) {
        this._fadeRaf = requestAnimationFrame(tick);
      } else {
        this._opacity = target;
        this._fadeRaf = null;
        if (onDone) onDone();
      }
    };
    this._fadeRaf = requestAnimationFrame(tick);
  },

  _redrawOpacity() {
    if (!this._icons || !this._lastRenderItems.length) return;
    this._icons.removeAll();
    this._labels.removeAll();
    for (const { pos, iconUrl, cls, name } of this._lastRenderItems) {
      this._icons.add({
        position: pos,
        image:    iconUrl,
        width:    28,
        height:   28,
        color:    new Cesium.Color(1, 1, 1, this._opacity * this._detectOpacity),
        disableDepthTestDistance:  Infinity,
        scaleByDistance:           new Cesium.NearFarScalar(2e6, 1.0, 5e7, 0.5),
        translucencyByDistance:    new Cesium.NearFarScalar(1e6, 1.0, 2e8, 0.0),
      });
      this._labels.add({
        position:     pos,
        text:         name,
        font:         '10px monospace',
        fillColor:    new Cesium.Color(cls.color.red, cls.color.green, cls.color.blue, cls.color.alpha * this._opacity * this._labelOpacity * this._detectOpacity),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:  new Cesium.Cartesian2(18, 0),
        disableDepthTestDistance: Infinity,
        translucencyByDistance:   new Cesium.NearFarScalar(1e6, 1.0, 1.5e8, 0.0),
      });
    }
  },

  async enable(viewer) {
    this._opacity = 0.0;
    this._labelOpacity = this._labelsVisible ? 1.0 : 0.0;
    this._icons.show  = true;
    this._labels.show = this._labelsVisible;

    if (this._sats.length === 0) {
      await this._fetchTLEs();
    }

    this._tick();
    this._startFade(1.0, null);
    this._intervalId = setInterval(() => this._tick(), UPDATE_MS);
    this._setupClickHandler(viewer);

    console.log(`[satellites] Enabled — ${this._sats.length} objects tracked`);
  },

  disable(viewer) {
    if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
    if (this._clickHandler) { this._clickHandler.destroy(); this._clickHandler = null; }
    if (this._orbitEntity)  { viewer.entities.remove(this._orbitEntity);  this._orbitEntity  = null; }
    if (this._reticleEntity){ viewer.entities.remove(this._reticleEntity); this._reticleEntity = null; }
    this._selectedSatrec = null;
    this._clearNadirLines();
    this._startFade(0.0, () => {
      this._icons.show  = false;
      this._labels.show = false;
      this._lastRenderItems = [];
    });
  },

  refresh() {},

  // ── Private ───────────────────────────────────────────────────────────────

  async _fetchTLEs() {
    try {
      const res = await fetch(TLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this._sats = parseSatnogsJSON(json);
      console.log(`[satellites] Loaded ${this._sats.length} TLEs from SatNOGS`);
    } catch (e) {
      console.error('[satellites] TLE fetch failed:', e.message);
    }
  },

  _tick() {
    const now = new Date();
    this._icons.removeAll();
    this._labels.removeAll();

    // Sparse mode: show every 4th satellite for even distribution
    const step = isFull() ? 1 : 4;
    this._lastRenderItems = [];
    for (let i = 0; i < this._sats.length; i += step) {
      const { name, satrec, noradId } = this._sats[i];
      const pos = propagateSat(satrec, now);
      if (!pos) continue;

      const cls    = classifySatellite(name);
      const iconUrl = buildCountryIcon(cls.color);
      this._lastRenderItems.push({ pos, iconUrl, cls, name });

      this._icons.add({
        position: pos,
        image:    iconUrl,
        width:    28,
        height:   28,
        id:       { name, satrec, noradId, country: cls.country },
        color:    new Cesium.Color(1, 1, 1, this._opacity * this._detectOpacity),
        disableDepthTestDistance:  Infinity,
        scaleByDistance:           new Cesium.NearFarScalar(2e6, 1.0, 5e7, 0.5),
        translucencyByDistance:    new Cesium.NearFarScalar(1e6, 1.0, 2e8, 0.0),
      });

      this._labels.add({
        position:     pos,
        text:         name,
        font:         '10px monospace',
        fillColor:    new Cesium.Color(cls.color.red, cls.color.green, cls.color.blue, cls.color.alpha * this._opacity * this._detectOpacity),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:  new Cesium.Cartesian2(18, 0),
        disableDepthTestDistance: Infinity,
        translucencyByDistance:   new Cesium.NearFarScalar(1e6, 1.0, 1.5e8, 0.0),
      });
    }

    // Update reticle and orbit for selected satellite
    if (this._selectedSatrec) {
      const selPos = propagateSat(this._selectedSatrec, now);
      if (selPos) this._updateReticle(selPos);
      this._drawOrbit(this._selectedSatrec, now);
    }

    // Nadir lines when conflict monitor is active
    if (this._nadirTarget && this.enabled) {
      this._updateNadirLines(now);
    }
  },

  _updateNadirLines(now) {
    this._clearNadirLines();

    const targetCart = Cesium.Cartesian3.fromDegrees(
      this._nadirTarget.lon, this._nadirTarget.lat, 0
    );

    for (const { name, satrec } of this._sats) {
      const pos = propagateSat(satrec, now);
      if (!pos) continue;

      const dist = Cesium.Cartesian3.distance(pos, targetCart);
      if (dist > NADIR_DIST_THRESHOLD) continue;

      const cls = classifySatellite(name);

      // Lines are thin and semi-transparent — white-ish, color-matched to country
      const lineColor = cls.country === 'commercial'
        ? new Cesium.Color(1.0, 1.0, 1.0, 0.35)
        : cls.color.withAlpha(0.5);

      const lineEntity = this._viewer.entities.add({
        polyline: {
          positions: [pos, targetCart],
          width:     1,
          material:  new Cesium.ColorMaterialProperty(lineColor),
          arcType:   Cesium.ArcType.NONE,  // straight 3D, not geodesic
        },
      });
      this._nadirLines.push(lineEntity);
    }
  },

  _clearNadirLines() {
    for (const e of this._nadirLines) {
      this._viewer.entities.remove(e);
    }
    this._nadirLines = [];
  },

  _updateReticle(position) {
    if (this._reticleEntity) {
      this._viewer.entities.remove(this._reticleEntity);
    }
    this._reticleEntity = this._viewer.entities.add({
      position,
      billboard: {
        image:  _buildReticleCanvas(),
        width:  48,
        height: 48,
        color:  Cesium.Color.YELLOW,
        disableDepthTestDistance: Infinity,
      },
      label: {
        text:         `${this._selectedName || ''}\n${this._selectedSatrec?.satnum || ''}`,
        font:         '11px monospace',
        fillColor:    Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:  new Cesium.Cartesian2(30, -16),
        disableDepthTestDistance: Infinity,
      },
    });
  },

  _drawOrbit(satrec, now) {
    if (this._orbitEntity) {
      this._viewer.entities.remove(this._orbitEntity);
    }

    const positions = buildOrbitPositions(satrec, now);
    if (positions.length < 2) return;

    this._orbitEntity = this._viewer.entities.add({
      polyline: {
        positions,
        width:    ORBIT_WIDTH,
        material: new Cesium.ColorMaterialProperty(ORBIT_COLOR),
        arcType:  Cesium.ArcType.NONE,
      },
    });
  },

  _setupClickHandler(viewer) {
    if (this._clickHandler) this._clickHandler.destroy();
    this._clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    this._clickHandler.setInputAction((event) => {
      if (!this.enabled) return;
      const picked = viewer.scene.pick(event.position);
      if (!picked?.id?.satrec) return;

      const { name, satrec, noradId, country } = picked.id;
      this._selectedSatrec = satrec;
      this._selectedName   = name;
      console.log(`[satellites] Tracking: ${name} (NORAD ${noradId}) [${country || 'unknown'}]`);
      this._drawOrbit(satrec, new Date());

      window.dispatchEvent(new CustomEvent('ea:satellite-selected', {
        detail: { name, noradId, country: country || 'unknown' },
      }));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  },
};
