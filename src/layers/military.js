/**
 * military.js — Military Flight Overlay
 *
 * Shows military aircraft from ADSB Exchange (paid) or airplanes.live free
 * military endpoint. Orange icons, distinct from white commercial flights.
 * Same click-to-select pattern as flights.js.
 *
 * Data:    ADSB Exchange via RapidAPI — military-only endpoint
 *          https://adsbexchange-com1.p.rapidapi.com/v2/mil/
 *          Requires: VITE_ADSB_KEY in .env (~$10/mo)
 *
 * Render:  BillboardCollection — orange icons, visually distinct from white commercial
 * Poll:    Every 15s (same cadence as flights.js)
 * Toggle:  Independent layer; can be shown over/under FlightsLayer
 * Click:   ICAO hex, callsign, aircraft type; custom event for HUD
 *
 * Reference frames: frame_00871.png (orange overlay), frame_00949.png (military-only filter)
 *
 * ADSB Exchange v2 aircraft record fields used:
 *   hex      — ICAO 24-bit address
 *   flight   — callsign (may be padded with spaces)
 *   t        — aircraft type code
 *   lat/lon  — decimal degrees
 *   alt_baro — pressure altitude in feet ("ground" if on ground)
 *   gs       — ground speed in knots
 *   track    — true track, degrees CW from north
 */

import * as Cesium from 'cesium';
import { sparseSample } from '../detectMode.js';

// ─── Selection reticle (amber corner brackets) ──────────────────────────────

let _reticleUrl = null;
function _buildReticle() {
  if (_reticleUrl) return _reticleUrl;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255, 190, 20, 0.85)';
  ctx.lineWidth = 1.5;
  const m = 4, s = 10;
  [[m,m],[38,m],[m,38],[38,38]].forEach(([x,y]) => {
    const dx = x < 24 ? s : -s, dy = y < 24 ? s : -s;
    ctx.beginPath(); ctx.moveTo(x+dx,y); ctx.lineTo(x,y); ctx.lineTo(x,y+dy); ctx.stroke();
  });
  _reticleUrl = c.toDataURL();
  return _reticleUrl;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const ADSB_URL        = 'https://adsbexchange-com1.p.rapidapi.com/v2/mil/';
const RAPIDAPI_HOST   = 'adsbexchange-com1.p.rapidapi.com';
// Free fallback: airplanes.live dedicated military endpoint (no key required)
const AIRPLANESLIVE_URL = 'https://api.airplanes.live/v2/mil';
const POLL_MS         = 15_000;

// Visual — match frame_00871 (orange, slightly larger than commercial white dots)
const ICON_SIZE      = 12;
const MILITARY_COLOR = new Cesium.Color(1.0, 0.4, 0.0, 1.0); // #ff6600
const ALT_FLOOR_M    = 5000; // raise slightly above commercial layer

// ─── Military aircraft icon (orange arrow, same shape as flights icon) ────────

function makeMilitaryIcon() {
  const sz  = 24;
  const c   = document.createElement('canvas');
  c.width   = sz;
  c.height  = sz;
  const ctx = c.getContext('2d');

  // Orange arrow pointing north — rotated by heading at render time
  ctx.fillStyle = '#ff6600';
  ctx.beginPath();
  ctx.moveTo(sz / 2,  1);
  ctx.lineTo(sz - 2, sz - 3);
  ctx.lineTo(sz / 2, sz - 7);
  ctx.lineTo(2,      sz - 3);
  ctx.closePath();
  ctx.fill();

  // Thin black outline for visibility against both dark sky and bright tiles
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth   = 0.8;
  ctx.stroke();

  return c.toDataURL();
}

// ─── Altitude conversion ──────────────────────────────────────────────────────

function feetToMeters(ft) {
  if (ft === 'ground' || ft == null) return 0;
  return parseFloat(ft) * 0.3048;
}

// ─── Layer Module ─────────────────────────────────────────────────────────────

export const MilitaryLayer = {
  id:      'military',
  label:   'Military',
  enabled: false,

  _billboards:    null,  // Cesium.BillboardCollection
  _reticleBb:     null,  // Cesium.BillboardCollection for selection reticle
  _labelsColl:    null,  // Cesium.LabelCollection
  _iconUrl:       null,
  _aircraft:      [],    // ADSB Exchange ac[] records
  _intervalId:    null,
  _clickHandler:  null,
  _apiKey:        null,
  _selectedIcao:  null,  // currently selected aircraft ICAO hex
  _showLabels:    false,
  _opacity:       0.0,
  _fadeRaf:       null,
  _labelOpacity:  0.0,
  _labelFadeRaf:  null,
  _detectOpacity: 1.0,
  _detectFadeRaf: null,

  // ── LayerModule interface ──────────────────────────────────────────────────

  init(viewer) {
    this._apiKey  = import.meta.env.VITE_ADSB_KEY ?? '';
    this._iconUrl = makeMilitaryIcon();
    this._billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
    this._reticleBb  = new Cesium.BillboardCollection({ scene: viewer.scene });
    this._labelsColl = new Cesium.LabelCollection();
    viewer.scene.primitives.add(this._billboards);
    viewer.scene.primitives.add(this._reticleBb);
    viewer.scene.primitives.add(this._labelsColl);
    this._billboards.show = false;
    this._reticleBb.show  = false;
    this._labelsColl.show = false;
    window.addEventListener('ea:detectPre', () => {
      if (this._billboards.show) this._startDetectFade(0.0);
    });
    window.addEventListener('ea:detectChange', () => {
      if (!this._billboards.show) return;
      this._detectOpacity = 0.0;
      this._render();
      this._startDetectFade(1.0);
    });

    if (!this._apiKey) {
      console.info('[military] VITE_ADSB_KEY not set — using airplanes.live free fallback (military:true filter)');
    }
  },

  setLabels(on) {
    this._showLabels = on;
    if (!this.enabled) return;
    if (on) {
      this._labelsColl.show = true;
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
      this._render();
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
      this._render();
      if (t < 1.0) {
        this._labelFadeRaf = requestAnimationFrame(tick);
      } else {
        this._labelOpacity = target;
        this._labelFadeRaf = null;
        if (target === 0.0) this._labelsColl.show = false;
      }
    };
    this._labelFadeRaf = requestAnimationFrame(tick);
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
      this._render();
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

  async enable(viewer) {
    this._opacity = 0.0;
    this._labelOpacity = this._showLabels ? 1.0 : 0.0;
    this._billboards.show = true;
    this._reticleBb.show  = true;
    this._labelsColl.show = this._showLabels;
    this._startFade(1.0, null);
    await this._fetch();
    this._intervalId = setInterval(() => this._fetch(), POLL_MS);
    this._setupClickHandler(viewer);
    console.log('[military] Enabled — polling ADSB Exchange every 15s');
  },

  disable(viewer) {
    this._selectedIcao = null;
    clearInterval(this._intervalId);
    this._intervalId = null;
    if (this._clickHandler) { this._clickHandler.destroy(); this._clickHandler = null; }
    this._startFade(0.0, () => {
      this._billboards.show = false;
      this._reticleBb.show  = false;
      this._labelsColl.show = false;
    });
  },

  refresh() {
    // External tick hook — polling is self-managed via setInterval
  },

  // ── Private ───────────────────────────────────────────────────────────────

  async _fetch() {
    if (this._apiKey) {
      await this._fetchADSBExchange();
    } else {
      await this._fetchAirplanesLive();
    }
  },

  async _fetchADSBExchange() {
    try {
      const res = await fetch(ADSB_URL, {
        headers: {
          'X-RapidAPI-Key':  this._apiKey,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
      });

      if (res.status === 429) {
        console.warn('[military] Rate limited by ADSB Exchange — backing off');
        return;
      }
      if (!res.ok) throw new Error(`ADSB Exchange HTTP ${res.status}`);

      const data = await res.json();
      // v2 envelope: { ac: [...], total, now, msg }
      this._aircraft = (data.ac ?? []).filter(a => a.lat != null && a.lon != null);
      this._render();
    } catch (e) {
      console.warn('[military] ADSB Exchange fetch error:', e.message);
    }
  },

  async _fetchAirplanesLive() {
    try {
      const res = await fetch(AIRPLANESLIVE_URL);
      if (!res.ok) throw new Error(`airplanes.live HTTP ${res.status}`);
      const data = await res.json();
      // /v2/mil returns only military aircraft — just filter for valid position
      this._aircraft = (data.ac ?? []).filter(
        a => a.lat != null && a.lon != null
      );
      this._render();
    } catch (e) {
      console.warn('[military] airplanes.live fetch error:', e.message);
    }
  },

  _render() {
    this._billboards.removeAll();
    this._reticleBb.removeAll();
    this._labelsColl.removeAll();

    const visible = sparseSample(this._aircraft, a => a.lat, a => a.lon, 4);
    for (const ac of visible) {
      const lon    = ac.lon;
      const lat    = ac.lat;
      const altM   = feetToMeters(ac.alt_baro) + ALT_FLOOR_M;
      const rotRad = -Cesium.Math.toRadians(parseFloat(ac.track) || 0);
      const pos    = Cesium.Cartesian3.fromDegrees(lon, lat, altM);
      const isSelected = ac.hex === this._selectedIcao;

      this._billboards.add({
        position:    pos,
        image:       this._iconUrl,
        width:       isSelected ? ICON_SIZE + 4 : ICON_SIZE,
        height:      isSelected ? ICON_SIZE + 4 : ICON_SIZE,
        rotation:    rotRad,
        alignedAxis: Cesium.Cartesian3.ZERO,
        color:       new Cesium.Color(1.0, 0.4, 0.0, this._opacity * this._detectOpacity),
        id: {
          icao:     ac.hex,
          callsign: ac.flight ? ac.flight.trim() : ac.hex,
          type:     ac.t ?? 'unknown',
          altitude: ac.alt_baro,
          speed_kt: ac.gs,
          ac,
        },
      });

      if (isSelected) {
        this._reticleBb.add({
          position: pos,
          image:    _buildReticle(),
          width:    48,
          height:   48,
          disableDepthTestDistance: Infinity,
        });
      }

      if ((this._labelOpacity > 0.001 && this._showLabels) || isSelected) {
        const callsign = ac.flight ? ac.flight.trim() : ac.hex;
        this._labelsColl.add({
          position:     pos,
          text:         callsign,
          font:         isSelected ? '11px monospace' : '9px monospace',
          fillColor:    isSelected ? new Cesium.Color(1,1,1,this._opacity*this._detectOpacity) : new Cesium.Color(1.0, 0.4, 0.0, 0.8 * this._opacity * this._labelOpacity * this._detectOpacity),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:  new Cesium.Cartesian2(14, 0),
          disableDepthTestDistance: Infinity,
          scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 5e6, 0.4),
        });
      }
    }

    console.log(`[military] Rendered ${visible.length}/${this._aircraft.length} military aircraft`);
  },

  _setupClickHandler(viewer) {
    if (this._clickHandler) this._clickHandler.destroy();
    this._clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    this._clickHandler.setInputAction((event) => {
      if (!this.enabled) return;
      const picked = viewer.scene.pick(event.position);

      if (!picked?.id?.icao) {
        if (this._selectedIcao) {
          this._selectedIcao = null;
          this._render();
        }
        return;
      }

      const { icao, callsign, type, altitude, speed_kt } = picked.id;
      this._selectedIcao = icao;
      this._render();

      console.log(`[military] ${callsign} (${type}) | alt: ${altitude}ft | ${speed_kt}kt`);

      window.dispatchEvent(new CustomEvent('ea:military-selected', {
        detail: { icao, callsign, type, altitude, speed_kt },
      }));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  },
};
