/**
 * traffic.js — OSM Road Network Particle System
 *
 * Fetches OSM road ways from Overpass API (motorway, trunk, primary, secondary)
 * in the current viewport. Spawns particles that move along road segments at
 * speed tiers (motorway fastest, residential slowest). Each particle has a
 * VEH-XXXX label. Colors adapt to shader mode (normal, NVG, FLIR, CRT).
 *
 * Uses requestAnimationFrame for per-frame position updates. Caches road
 * data in sessionStorage to avoid re-fetching on layer toggle.
 */

import * as Cesium from 'cesium';

// ─── Constants ────────────────────────────────────────────────────────────────

// Rotate through mirrors — one request total, fallback on 429/error
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const FETCH_TIMEOUT_MS = 20000;

// Highway type → tier config (assigned after single combined fetch)
// speed = target meters-per-second for each road type
const TIER_BY_HIGHWAY = {
  motorway:    { maxParticles: 300, speed: 25, pixelSize: 2.8 },  // ~90 km/h
  trunk:       { maxParticles: 250, speed: 20, pixelSize: 2.6 },  // ~72 km/h
  primary:     { maxParticles: 300, speed: 14, pixelSize: 2.4 },  // ~50 km/h
  secondary:   { maxParticles: 250, speed: 10, pixelSize: 2.0 },  // ~36 km/h
  tertiary:    { maxParticles: 150, speed:  7, pixelSize: 1.8 },  // ~25 km/h
  residential: { maxParticles: 150, speed:  5, pixelSize: 1.6 },  // ~18 km/h
};

const MAX_TOTAL_PARTICLES = 1200;   // fewer but labeled — matches reference density

const LABEL_COLOR  = new Cesium.Color(1.0, 0.75, 0.0, 0.9);  // amber, matches VEH-XXXX in reference
const LABEL_COLORS = {
  normal: new Cesium.Color(1.0, 0.75, 0.0, 0.9),
  nvg:    new Cesium.Color(0.15, 1.0, 0.15, 0.90),
  flir:   new Cesium.Color(1.0, 0.45, 0.0, 0.85),
  crt:    new Cesium.Color(0.0, 1.0, 0.45, 0.85),
};

// Viewport span in degrees (~5.5km radius — smaller = faster Overpass query)
const QUERY_SPAN_DEG = 0.05;

// Particle colors per visual mode
const MODE_COLORS = {
  normal: new Cesium.Color(1.0, 1.0, 1.0, 0.85),
  nvg:    new Cesium.Color(0.15, 1.0, 0.15, 0.90),
  flir:   new Cesium.Color(1.0, 0.45, 0.0, 0.85),
  crt:    new Cesium.Color(0.0, 1.0, 0.45, 0.85),
};

// ─── Layer Module ─────────────────────────────────────────────────────────────

export const TrafficLayer = {
  id: 'traffic',
  label: 'Street Traffic',
  enabled: false,

  // Internal state
  _points:    null,
  _labels:    null,
  _particles: [],
  _segments:  [],
  _colorMode: 'normal',
  _rafId:     null,
  _lastTimestamp: null,
  _viewer: null,

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  init(viewer) {
    this._viewer = viewer;
    this._points = new Cesium.PointPrimitiveCollection();
    this._labels = new Cesium.LabelCollection();
    viewer.scene.primitives.add(this._points);
    viewer.scene.primitives.add(this._labels);
    this._points.show = false;
    this._labels.show = false;
  },

  enable(viewer) {
    this._viewer = viewer;
    this._points.show = true;
    this._labels.show = true;
    this._loadRoads(viewer);
    const loop = () => {
      if (!this.enabled) return;
      this._tick();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  },

  disable(viewer) {
    this._points.show = false;
    this._labels.show = false;

    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }

    this._particles = [];
    this._segments = [];
    this._lastTimestamp = null;
    this._points.removeAll();
    this._labels.removeAll();
  },

  refresh() {
    // Traffic is animation-driven; no external poll needed.
  },

  /**
   * Called by shaderMode.js (Agent A) when visual mode changes.
   * @param {'normal'|'nvg'|'flir'|'crt'} mode
   */
  setMode(mode) {
    this._colorMode = mode;
    const ptColor  = MODE_COLORS[mode]  ?? MODE_COLORS.normal;
    const lblColor = LABEL_COLORS[mode] ?? LABEL_COLORS.normal;
    for (let i = 0; i < this._points.length; i++) {
      this._points.get(i).color = ptColor;
    }
    for (let i = 0; i < this._labels.length; i++) {
      this._labels.get(i).fillColor = lblColor;
    }
  },

  // ─── Road Data Loading ───────────────────────────────────────────────────────

  _loadRoads(viewer) {
    const bbox = this._getQueryBbox(viewer);
    this._fetchAllRoads(bbox);
  },

  _getQueryBbox(viewer) {
    try {
      const carto = viewer.camera.positionCartographic;
      const cx = Cesium.Math.toDegrees(carto.longitude);
      const cy = Cesium.Math.toDegrees(carto.latitude);
      console.log(`[TrafficLayer] Querying bbox around ${cy.toFixed(3)}, ${cx.toFixed(3)}`);
      return `${cy - QUERY_SPAN_DEG},${cx - QUERY_SPAN_DEG},${cy + QUERY_SPAN_DEG},${cx + QUERY_SPAN_DEG}`;
    } catch (_) {}
    return '37.73,-122.50,37.83,-122.40'; // SF fallback
  },

  async _fetchAllRoads(bbox) {
    const cacheKey = `ultor_traffic_${bbox}`;
    const query =
      `[out:json][timeout:25];` +
      `way["highway"~"motorway|trunk|primary|secondary"](${bbox});` +
      `out geom;`;

    let data;

    // Cache in sessionStorage — avoids re-hitting Overpass on toggle/reload
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        data = JSON.parse(cached);
        console.log(`[TrafficLayer] Cached: ${data.elements?.length} ways`);
      } catch (_) { sessionStorage.removeItem(cacheKey); }
    }

    if (!data) for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        console.log(`[TrafficLayer] Trying ${endpoint}...`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const resp = await fetch(endpoint, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   'Ultor/1.0 (desktop analytics)',
          },
          body:   `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        if (text.trimStart().startsWith('<')) throw new Error('XML response');
        data = JSON.parse(text);
        console.log(`[TrafficLayer] OK from ${endpoint}`);
        try { sessionStorage.setItem(cacheKey, text); } catch (_) {}
        break;
      } catch (err) {
        console.warn(`[TrafficLayer] ${endpoint} failed: ${err.message}`);
      }
    }

    if (!data) {
      console.error('[TrafficLayer] All Overpass endpoints failed.');
      return;
    }

    const ways = data?.elements ?? [];
    console.log(`[TrafficLayer] ${ways.length} ways returned`);
    if (ways.length === 0) return;

    // Group ways by highway type and spawn particles per tier config
    const byType = {};
    for (const way of ways) {
      const hw = way.tags?.highway ?? 'residential';
      if (!byType[hw]) byType[hw] = [];
      byType[hw].push(way);
    }

    for (const [hw, hwWays] of Object.entries(byType)) {
      const tier = TIER_BY_HIGHWAY[hw] ?? TIER_BY_HIGHWAY.residential;
      const segStart = this._segments.length;
      const newSegs  = this._buildSegments(hwWays);
      if (newSegs.length === 0) continue;
      this._segments.push(...newSegs);
      this._spawnParticles(tier, segStart, newSegs.length);
      if (this._particles.length >= MAX_TOTAL_PARTICLES) break;
    }

    console.log(`[TrafficLayer] ${this._particles.length} particles active`);
  },

  _buildSegments(ways) {
    const segs = [];
    for (const way of ways) {
      if (way.type !== 'way' || !way.geometry || way.geometry.length < 2) continue;

      const nodes = way.geometry.map(({ lat, lon }) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, 3) // 3m above ground clears road surface z-fighting
      );

      segs.push({ nodes });
    }
    return segs;
  },

  // ─── Particle Spawning ───────────────────────────────────────────────────────

  _spawnParticles(tier, segStart, segCount) {
    const budget = Math.min(
      tier.maxParticles,
      MAX_TOTAL_PARTICLES - this._particles.length
    );
    const color = MODE_COLORS[this._colorMode] ?? MODE_COLORS.normal;

    for (let i = 0; i < budget; i++) {
      const segIdx = segStart + Math.floor(Math.random() * segCount);
      const seg = this._segments[segIdx];
      const nodeIdx = Math.floor(Math.random() * (seg.nodes.length - 1));
      const t = Math.random();

      // Normalize speed by segment length so all particles move at ~same m/s
      // target: ~15 m/s for motorway down to ~5 m/s for residential
      const segLen = Cesium.Cartesian3.distance(
        seg.nodes[nodeIdx],
        seg.nodes[nodeIdx + 1]
      );
      // speed = target_m_per_s / segment_length_m  (segments/sec)
      const speed = Math.min(tier.speed / Math.max(segLen, 1), 10);

      const pos = Cesium.Cartesian3.lerp(
        seg.nodes[nodeIdx],
        seg.nodes[nodeIdx + 1],
        t,
        new Cesium.Cartesian3()
      );

      const ptIdx = this._points.length;
      const vehId = `VEH-${String(ptIdx).padStart(4, '0')}`;

      this._points.add({
        position:  pos,
        color:     color,
        pixelSize: tier.pixelSize + 1.5,  // brighter, more visible
        scaleByDistance:        new Cesium.NearFarScalar(100, 3.0, 60000, 0.5),
        translucencyByDistance: new Cesium.NearFarScalar(200, 1.0, 80000, 0.0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });

      this._labels.add({
        position:    pos,
        text:        vehId,
        font:        '9px monospace',
        fillColor:   LABEL_COLORS[this._colorMode] ?? LABEL_COLORS.normal,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style:       Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(8, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(200, 1.0, 60000, 0.0),
      });

      this._particles.push({
        ptIdx,
        segIdx,
        nodeIdx,
        t,
        speed,
      });
    }
  },

  // ─── Per-Frame Animation ─────────────────────────────────────────────────────

  _tick() {
    if (this._particles.length === 0) return;

    const now = performance.now();
    const dt  = this._lastTimestamp
      ? Math.min((now - this._lastTimestamp) / 1000, 0.1)
      : 0.016;
    this._lastTimestamp = now;

    const totalSegs = this._segments.length;
    if (totalSegs === 0) return;

    for (const p of this._particles) {
      p.t += p.speed * dt;

      // Advance through nodes within the segment
      while (p.t >= 1.0) {
        p.t -= 1.0;
        p.nodeIdx++;

        const seg = this._segments[p.segIdx];
        if (!seg || p.nodeIdx >= seg.nodes.length - 1) {
          // End of road — loop back to start of same segment (no teleport)
          p.nodeIdx = 0;
          p.t = 0;
          break;
        }
      }

      const seg = this._segments[p.segIdx];
      if (!seg || p.nodeIdx >= seg.nodes.length - 1) continue;

      const pos = Cesium.Cartesian3.lerp(
        seg.nodes[p.nodeIdx],
        seg.nodes[p.nodeIdx + 1],
        p.t,
        new Cesium.Cartesian3()
      );

      this._points.get(p.ptIdx).position = pos;
      this._labels.get(p.ptIdx).position = pos;
    }
  },
};
