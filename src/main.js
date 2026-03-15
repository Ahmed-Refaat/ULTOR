/**
 * main.js — Ultor Application Entry Point
 *
 * Bootstraps the geospatial intelligence platform:
 * 1. Initializes CesiumJS 3D globe (globe.js)
 * 2. Creates LayerManager to register and control all data layers
 * 3. Registers layer modules (satellites, flights, maritime, etc.)
 * 4. Builds the HUD (head-up display) with layer toggles and controls
 *
 * The global object window.__ea exposes { viewer, layerManager } for layers
 * that need cross-module access. Conflict Monitor layers (gpsJamming,
 * airspaceClosure, groundTruthCards) are referenced in the HUD but must be
 * registered separately if Conflict Monitor mode is enabled.
 */

import 'cesium/Build/Cesium/Widgets/widgets.css';
import { initGlobe } from './globe.js';
import { LayerManager } from './layerManager.js';
import ShaderModeLayer from './layers/shaderMode.js';
import { SeismicLayer }    from './layers/seismic.js';
import { SatellitesLayer } from './layers/satellites.js';
import { FlightsLayer }    from './layers/flights.js';
import { MilitaryLayer }   from './layers/military.js';
import { TrafficLayer }    from './layers/traffic.js';
import { CamerasLayer }          from './layers/cameras.js';
import { MaritimeLayer }         from './layers/maritime.js';
import { initHUD }               from './hud.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Initialize Cesium viewer with 3D tiles and base imagery, then create the
// layer manager. All layers receive the viewer instance for adding primitives.

const viewer = await initGlobe('cesium-container');
const layerManager = new LayerManager(viewer);

// Expose viewer and layerManager globally for layers that need cross-module access
// (e.g. conflictMonitor, layers that listen to custom events)
window.__ea = { viewer, layerManager };

console.log('[Ultor] Globe initialized. viewer and layerManager ready on window.__ea');

// ─── Layer Registration ───────────────────────────────────────────────────────
// Each layer implements the LayerModule interface (id, label, enabled, init,
// enable, disable, refresh). Order matters for visual stacking. ShaderMode
// is always first (post-processing). Conflict layers (gpsJamming, airspaceClosure,
// groundTruthCards) are not registered here — they are used only when Conflict
// Monitor mode is active and would need to be added if that mode is wired up.

layerManager.register([
  ShaderModeLayer,
  SeismicLayer,
  SatellitesLayer,
  FlightsLayer,
  MilitaryLayer,
  TrafficLayer,
  CamerasLayer,
  MaritimeLayer,
]);

initHUD(layerManager);
