/**
 * flights.js — Live Commercial Flight Tracking
 *
 * Polls airplanes.live for global flight positions. Renders aircraft-style
 * arrows oriented by heading. Click to select and show callsign/altitude/speed
 * in the HUD info panel.
 *
 * Data:    airplanes.live — free, no key, ~7k global flights
 *          https://api.airplanes.live/v2/point/0/0/21600
 *          (OpenSky was replaced — it rate-limits anonymous users to 429 frequently)
 *
 * Render:  BillboardCollection — small aircraft arrows oriented to heading
 * Poll:    Every 30s
 * Click:   Callsign / altitude / speed info; custom event for HUD
 */

import * as Cesium from 'cesium';
import { sparseSample } from '../detectMode.js';

// ─── Config ───────────────────────────────────────────────────────────────────

// airplanes.live: global coverage, no key, no rate limit issues
const FLIGHTS_URL = 'https://api.airplanes.live/v2/point/0/0/21600';
const POLL_MS     = 30_000;

// Visual — match frame_00631 (dense white dots / small arrows)
const ICON_SIZE       = 10;   // billboard pixels
const FLIGHT_COLOR    = new Cesium.Color(1.0, 1.0, 1.0, 0.85);
const ALT_FLOOR_M     = 3000; // raise icons above terrain for visibility

// ─── Selection reticle (amber corner brackets, matches satellite/ship style) ─

let _reticleUrl = null;
function _buildReticle() {
  if (_reticleUrl) return _reticleUrl;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255, 190, 20, 0.85)';
  ctx.lineWidth = 1.5;
  const m = 4, s = 10;
  // Four corner brackets
  [[m,m],[38,m],[m,38],[38,38]].forEach(([x,y]) => {
    const dx = x < 24 ? s : -s, dy = y < 24 ? s : -s;
    ctx.beginPath(); ctx.moveTo(x+dx,y); ctx.lineTo(x,y); ctx.lineTo(x,y+dy); ctx.stroke();
  });
  _reticleUrl = c.toDataURL();
  return _reticleUrl;
}

// ─── Aircraft icon (arrow pointing north, rotated by heading at render time) ──

function makeAircraftIcon() {
  const sz  = 24;
  const c   = document.createElement('canvas');
  c.width   = sz;
  c.height  = sz;
  const ctx = c.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.moveTo(sz / 2,  1);        // nose (top center)
  ctx.lineTo(sz - 2, sz - 3);   // starboard wing tip
  ctx.lineTo(sz / 2, sz - 7);   // tail notch
  ctx.lineTo(2,      sz - 3);   // port wing tip
  ctx.closePath();
  ctx.fill();

  return c.toDataURL();
}

// ─── Layer Module ─────────────────────────────────────────────────────────────

export const FlightsLayer = {
  id:      'flights',
  label:   'Flights',
  enabled: false,

  _billboards:    null,  // Cesium.BillboardCollection
  _reticleBb:     null,  // Cesium.BillboardCollection for selection reticle
  _labelsColl:    null,  // Cesium.LabelCollection
  _trackEntity:   null,  // viewer.entities ground track for selected flight
  _iconUrl:       null,  // data URL for aircraft arrow
  _states:        [],    // raw OpenSky state vectors
  _intervalId:    null,
  _clickHandler:  null,
  _viewer:        null,
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
    this._viewer  = viewer;
    this._iconUrl = makeAircraftIcon();
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
    console.log('[flights] Enabled — polling airplanes.live every 30s');
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
      if (this._trackEntity) {
        viewer.entities.remove(this._trackEntity);
        this._trackEntity = null;
      }
    });
  },

  refresh() {
    // External tick hook — polling is self-managed via setInterval
  },

  // ── Private ───────────────────────────────────────────────────────────────

  async _fetch() {
    try {
      const res = await fetch(FLIGHTS_URL);
      if (!res.ok) throw new Error(`airplanes.live HTTP ${res.status}`);
      const data = await res.json();
      // airplanes.live: { ac: [...], total, now }
      // each ac: { hex, flight, lat, lon, alt_baro, gs (knots), track (heading), type }
      this._states = (data.ac ?? []).filter(
        a => a.lat != null && a.lon != null && a.alt_baro !== 'ground'
      );
      this._render();
    } catch (e) {
      console.warn('[flights] fetch error:', e.message);
    }
  },

  _render() {
    this._billboards.removeAll();
    this._reticleBb.removeAll();
    this._labelsColl.removeAll();

    const visible = sparseSample(this._states, a => a.lat, a => a.lon, 3);
    for (const a of visible) {
      const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : 10000;
      const altM  = altFt * 0.3048 + ALT_FLOOR_M;
      const rotRad = -Cesium.Math.toRadians(a.track ?? 0);
      const pos = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, altM);
      const isSelected = a.hex === this._selectedIcao;

      this._billboards.add({
        position:    pos,
        image:       this._iconUrl,
        width:       isSelected ? ICON_SIZE + 4 : ICON_SIZE,
        height:      isSelected ? ICON_SIZE + 4 : ICON_SIZE,
        rotation:    rotRad,
        alignedAxis: Cesium.Cartesian3.ZERO,
        color:       new Cesium.Color(1.0, 1.0, 1.0, 0.85 * this._opacity * this._detectOpacity),
        id: {
          icao24:   a.hex,
          callsign: (a.flight ?? '').trim() || a.hex,
          altitude: altM,
          velocity: a.gs,
          type:     a.t || a.type || '',
          lat: a.lat, lon: a.lon,
        },
      });

      // Draw reticle bracket around selected aircraft
      if (isSelected) {
        this._reticleBb.add({
          position: pos,
          image:    _buildReticle(),
          width:    48,
          height:   48,
          disableDepthTestDistance: Infinity,
        });
      }

      // Callsign label
      if ((this._labelOpacity > 0.001 && this._showLabels) || isSelected) {
        const callsign = (a.flight ?? '').trim() || a.hex;
        this._labelsColl.add({
          position:     pos,
          text:         callsign,
          font:         isSelected ? '11px monospace' : '9px monospace',
          fillColor:    isSelected ? new Cesium.Color(1,1,1,this._opacity*this._detectOpacity) : new Cesium.Color(1,1,1,0.7*this._opacity*this._labelOpacity*this._detectOpacity),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:  new Cesium.Cartesian2(14, 0),
          disableDepthTestDistance: Infinity,
          scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 5e6, 0.4),
        });
      }
    }

    console.log(`[flights] Rendered ${visible.length}/${this._states.length} aircraft`);
  },

  _setupClickHandler(viewer) {
    if (this._clickHandler) this._clickHandler.destroy();
    this._clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    this._clickHandler.setInputAction((event) => {
      if (!this.enabled) return;
      const picked = viewer.scene.pick(event.position);

      // Click empty space — deselect
      if (!picked?.id?.icao24) {
        if (this._selectedIcao) {
          this._selectedIcao = null;
          this._render();
        }
        return;
      }

      const { icao24, callsign, altitude, velocity, lat, lon } = picked.id;
      this._selectedIcao = icao24;
      this._render();

      console.log(
        `[flights] ${callsign} | alt: ${Math.round(altitude ?? 0)}m | ` +
        `speed: ${Math.round((velocity ?? 0) * 1.944)}kt`
      );

      window.dispatchEvent(new CustomEvent('ea:flight-selected', {
        detail: { icao24, callsign, altitude, velocity },
      }));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  },
};
