/**
 * maritime.js — AIS Ship Tracking Layer
 *
 * Displays live ship positions from AIS (Automatic Identification System).
 * Data flows: aisstream.io WebSocket → Electron main process → local HTTP
 * proxy (http://127.0.0.1:17853). Requires VITE_AISSTREAM_KEY and Electron.
 *
 * Renders ship icons (circle + heading arrow), color-coded by type (cargo,
 * tanker, military). Click to select; fetches trail history from /trail?mmsi=.
 * Ships animate between position updates using heading/speed.
 */

import * as Cesium from 'cesium';
import { sparseSample } from '../detectMode.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const AIS_PROXY_URL  = 'http://127.0.0.1:17853';
const POLL_MS        = 10_000; // poll local AIS proxy every 10s

const SHIP_COLORS = {
  cargo:    '#00eecc',
  tanker:   '#ffcc00',
  military: '#ff3333',
  default:  '#00eecc',
};

const _iconCache = {};

function buildShipIcon(type, selected) {
  const key = (type || 'default') + (selected ? '_sel' : '');
  if (_iconCache[key]) return _iconCache[key];

  const color = SHIP_COLORS[type] || SHIP_COLORS.default;
  const sz    = 24;
  const half  = sz / 2;
  const c     = document.createElement('canvas');
  c.width = c.height = sz;
  const ctx = c.getContext('2d');

  // Circle body
  ctx.beginPath();
  ctx.arc(half, half, 6, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.fillStyle   = color + '33';
  ctx.fill();

  // Heading arrow pointing up (north = 0 deg, rotated at runtime)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(half,     half - 9);
  ctx.lineTo(half - 3, half - 4);
  ctx.lineTo(half + 3, half - 4);
  ctx.closePath();
  ctx.fill();

  // Amber corner brackets — only on selected ships
  if (selected) {
    ctx.strokeStyle = 'rgba(255, 190, 20, 0.85)';
    ctx.lineWidth   = 1.2;
    const m = 2, s = 5;
    ctx.beginPath(); ctx.moveTo(m+s, m);    ctx.lineTo(m,    m);    ctx.lineTo(m,    m+s);    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sz-m-s, m); ctx.lineTo(sz-m, m);    ctx.lineTo(sz-m, m+s);    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m+s, sz-m); ctx.lineTo(m,    sz-m); ctx.lineTo(m,    sz-m-s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sz-m-s, sz-m); ctx.lineTo(sz-m, sz-m); ctx.lineTo(sz-m, sz-m-s); ctx.stroke();
  }

  _iconCache[key] = c.toDataURL();
  return _iconCache[key];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function aisTypeToCategory(shipTypeNum) {
  const n = Number(shipTypeNum) || 0;
  if (n >= 70 && n <= 79) return 'cargo';
  if (n >= 80 && n <= 89) return 'tanker';
  if (n === 35 || n === 36) return 'military';
  return 'default';
}

/**
 * Move ship lat/lon by speed (knots) along heading for deltaMs milliseconds.
 * 1 knot = 1.852 km/h = 1.852 / (111 * 3600) degrees-lat per second.
 */
function advanceShip(ship, deltaMs) {
  const headingRad = (ship.heading * Math.PI) / 180;
  const dps        = (ship.speed * 1.852) / (111 * 3600 * 1000); // deg per ms
  ship.lat += Math.cos(headingRad) * dps * deltaMs;
  ship.lon += Math.sin(headingRad) * dps * deltaMs;
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ─── Layer Module ─────────────────────────────────────────────────────────────

export const MaritimeLayer = {
  id:      'maritime',
  label:   'Maritime Traffic',
  enabled: false,

  _ships:        null,   // Map<mmsi, ship>
  _icons:        null,   // BillboardCollection
  _labels:       null,   // LabelCollection
  _trailPoints:  null,   // PointPrimitiveCollection
  _viewer:       null,
  _intervalId:   null,
  _showLabels:    false,
  _clickHandler:  null,
  _selectedMmsi:  null,
  _selTrailEntity: null,  // Cesium.Entity for selected ship's trail polyline
  _selLabelEntity: null,  // Cesium.Entity for selected ship's label
  _animFrameId:   null,
  _lastAnimMs:    null,
  _opacity:       0.0,
  _fadeRaf:       null,
  _labelOpacity:  0.0,
  _labelFadeRaf:  null,
  _detectOpacity: 1.0,
  _detectFadeRaf: null,

  // ── LayerModule interface ──────────────────────────────────────────────────

  init(viewer) {
    this._viewer      = viewer;
    this._ships       = new Map();
    this._icons       = new Cesium.BillboardCollection({ scene: viewer.scene });
    this._labels      = new Cesium.LabelCollection();
    this._trailPoints = new Cesium.PointPrimitiveCollection();

    viewer.scene.primitives.add(this._icons);
    viewer.scene.primitives.add(this._labels);
    viewer.scene.primitives.add(this._trailPoints);

    this._icons.show       = false;
    this._labels.show      = false;
    this._trailPoints.show = false;
    window.addEventListener('ea:detectPre', () => {
      if (this._icons.show) this._startDetectFade(0.0);
    });
    window.addEventListener('ea:detectChange', () => {
      if (!this._icons.show) return;
      this._detectOpacity = 0.0;
      this._render();
      this._startDetectFade(1.0);
    });
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
    this._icons.show       = true;
    this._labels.show      = this._showLabels;
    this._trailPoints.show = true;
    this._ships.clear();
    await this._fetchLive();
    this._startFade(1.0, null);
    this._intervalId = setInterval(() => this._fetchLive(), POLL_MS);
    this._startAnimation();
    this._setupClickHandler(viewer);
  },

  disable(viewer) {
    if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
    if (this._clickHandler) { this._clickHandler.destroy(); this._clickHandler = null; }
    this._startFade(0.0, () => {
      this._icons.show       = false;
      this._labels.show      = false;
      this._trailPoints.show = false;
      this._clearSelection(viewer);
      this._stopAnimation();
    });
  },

  refresh() {},

  setLabels(on) {
    this._showLabels = on;
    if (!this.enabled) return;
    if (on) {
      this._labels.show = true;
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

  // ── Private ───────────────────────────────────────────────────────────────

  _startAnimation() {
    this._lastAnimMs = performance.now();
    const tick = () => {
      if (!this.enabled) return;
      const now = performance.now();
      const dt = now - this._lastAnimMs;
      this._lastAnimMs = now;

      // Advance all ships by heading/speed
      for (const ship of this._ships.values()) {
        if (ship.speed > 0) advanceShip(ship, dt);
      }
      this._render();
      this._animFrameId = requestAnimationFrame(tick);
    };
    this._animFrameId = requestAnimationFrame(tick);
  },

  _stopAnimation() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  },

  async _fetchLive() {
    try {
      const res = await fetch(AIS_PROXY_URL);
      if (!res.ok) {
        console.warn('[maritime] AIS proxy returned', res.status, res.statusText);
        return;
      }
      const data = await res.json();
      const incoming = data.ships || [];
      if (incoming.length === 0) {
        console.warn('[maritime] AIS proxy returned 0 ships — is VITE_AISSTREAM_KEY set? For packaged app, copy .env to ~/Library/Application Support/ultor/');
        return;
      }

      // Update ship map with latest positions from proxy
      for (const s of incoming) {
        const mmsi = String(s.mmsi);
        this._ships.set(mmsi, {
          mmsi,
          name:    (s.name || `VESSEL-${mmsi}`).trim(),
          type:    aisTypeToCategory(s.shipType),
          lat:     s.lat,
          lon:     s.lon,
          heading: s.heading ?? 0,
          speed:   s.speed ?? 0,
          trail:   this._ships.get(mmsi)?.trail || [],
        });
      }
      this._render();
      console.log(`[maritime] ${this._ships.size} ships`);
    } catch (e) {
      console.warn('[maritime] Fetch failed:', e.message, '— ensure Electron is running (AIS proxy needs main process)');
    }
  },


  _render() {
    if (!this._icons.show) return;

    this._icons.removeAll();
    this._labels.removeAll();
    this._trailPoints.removeAll();

    const allShips = [...this._ships.values()];
    const visible = sparseSample(allShips, s => s.lat, s => s.lon, 4);
    for (const ship of visible) {
      if (ship.lat == null || ship.lon == null) continue;

      const pos        = Cesium.Cartesian3.fromDegrees(ship.lon, ship.lat, 0);
      const colorHex   = SHIP_COLORS[ship.type] || SHIP_COLORS.default;
      const isSelected = ship.mmsi === this._selectedMmsi;
      const iconUrl    = buildShipIcon(ship.type, isSelected);
      const headingRad = Cesium.Math.toRadians(ship.heading || 0);

      this._icons.add({
        position:    pos,
        image:       iconUrl,
        width:       isSelected ? 28 : 24,
        height:      isSelected ? 28 : 24,
        id:          { mmsi: ship.mmsi, name: ship.name, type: ship.type },
        rotation:    -headingRad,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        color:       new Cesium.Color(1, 1, 1, this._opacity * this._detectOpacity),
        disableDepthTestDistance: Infinity,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 5e6, 0.6),
      });

      // Show label for selected ship or if global labels are on
      if ((this._labelOpacity > 0.001 && this._showLabels) || isSelected) {
        const labelText = `${ship.name} (${capitalize(ship.type)})`;
        this._labels.add({
          position:     pos,
          text:         labelText,
          font:         isSelected ? '12px monospace' : '10px monospace',
          fillColor:    Cesium.Color.fromCssColorString(isSelected ? '#ffffff' : colorHex).withAlpha(this._opacity * this._detectOpacity * (isSelected ? 1.0 : this._labelOpacity)),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:  new Cesium.Cartesian2(20, 0),
          disableDepthTestDistance: Infinity,
          scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 5e6, 0.5),
        });
      }
    }

    // Update ship count badge
    this._updateBadge();
  },

  _updateBadge() {
    const badge = document.getElementById('cnt-ships');
    if (!badge) return;
    if (!this.enabled) return;
    // Respect grace period from HUD toggle
    const g = window._eaLayerBadge;
    if (g?.graceUntil?.maritime && Date.now() < g.graceUntil.maritime) return;
    const n = this._ships.size;
    if (n >= 1_000_000) badge.textContent = (n / 1_000_000).toFixed(1) + 'm';
    else if (n >= 10_000) badge.textContent = Math.round(n / 1000) + 'k';
    else if (n >= 1000) badge.textContent = (n / 1000).toFixed(1) + 'k';
    else badge.textContent = String(n);
    badge.classList.remove('off');
  },

  _setupClickHandler(viewer) {
    if (this._clickHandler) this._clickHandler.destroy();
    this._clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    this._clickHandler.setInputAction((event) => {
      if (!this.enabled) return;
      const picked = viewer.scene.pick(event.position);

      // Click on empty space — deselect
      if (!picked?.id?.mmsi) {
        this._clearSelection(viewer);
        return;
      }

      const { mmsi, name, type } = picked.id;
      const ship = this._ships.get(mmsi);
      if (!ship) return;

      // Select this ship
      this._selectedMmsi = mmsi;
      this._render();
      this._fetchAndDrawTrail(viewer, mmsi);

      const speedKt = ship.speed ?? 0;
      const heading = ship.heading ?? 0;
      const shipType = capitalize(ship.type || 'unknown');

      console.log(`[maritime] Selected ${name} (${shipType}) | ${speedKt}kt | hdg ${heading}`);

      window.dispatchEvent(new CustomEvent('ea:ship-selected', {
        detail: {
          mmsi,
          name,
          type: shipType,
          lat:     ship.lat,
          lon:     ship.lon,
          speed:   speedKt,
          heading: heading,
        },
      }));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  },

  _clearSelection(viewer) {
    this._selectedMmsi = null;
    if (this._selTrailEntity) {
      viewer.entities.remove(this._selTrailEntity);
      this._selTrailEntity = null;
    }
    if (this._selLabelEntity) {
      viewer.entities.remove(this._selLabelEntity);
      this._selLabelEntity = null;
    }
    this._render();
  },

  async _fetchAndDrawTrail(viewer, mmsi) {
    // Remove previous trail
    if (this._selTrailEntity) {
      viewer.entities.remove(this._selTrailEntity);
      this._selTrailEntity = null;
    }

    // Fetch trail history from the AIS proxy
    let positions = [];
    try {
      const res = await fetch(`${AIS_PROXY_URL}/trail?mmsi=${mmsi}`);
      if (res.ok) {
        const data = await res.json();
        if (data.trail && data.trail.length > 1) {
          const coords = [];
          for (const pt of data.trail) {
            coords.push(pt.lon, pt.lat, 0);
          }
          positions = Cesium.Cartesian3.fromDegreesArrayHeights(coords);
        }
      }
    } catch {}

    // If no history from proxy, use current position as a single point
    const ship = this._ships.get(mmsi);
    if (positions.length < 2 && ship) {
      // Just show the current point — trail will build up over time
      return;
    }

    const colorHex = SHIP_COLORS[ship?.type] || SHIP_COLORS.default;

    this._selTrailEntity = viewer.entities.add({
      polyline: {
        positions,
        width: 2,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.15,
          color: Cesium.Color.fromCssColorString(colorHex).withAlpha(0.8),
        }),
        clampToGround: true,
      },
    });
  },
};
