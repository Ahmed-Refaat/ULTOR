# Layers — Data Visualization Modules

Each file in this directory is a self-contained **LayerModule** that visualizes a data source on the Cesium globe. All layers implement the same interface so the LayerManager can register, enable, and disable them uniformly.

---

## LayerModule Interface

Every layer must export an object with these properties and methods:

```js
export const MyLayer = {
  id: "my_layer",        // Unique key used by LayerManager (e.g. 'satellites')
  label: "My Layer",     // Display name in the HUD toggle panel
  enabled: false,        // Default on/off state (true = on at startup)
  init(viewer) {},       // One-time setup: create collections, add to scene
  enable(viewer) {},     // Show layer: start polling, add primitives
  disable(viewer) {},    // Hide layer: stop polling, remove primitives
  refresh() {},          // Optional: called on each data poll tick
};
```

---

## Registered Layers (main.js)

| File | id | Data Source | Notes |
|------|-----|-------------|-------|
| shaderMode.js | shaderMode | — | Post-processing: Normal, CRT, NVG, FLIR. Keys 1–4. |
| seismic.js | seismic | USGS GeoJSON | Earthquakes, past 7 days |
| satellites.js | satellites | SatNOGS TLE | SGP4 propagation, country classification |
| flights.js | flights | airplanes.live | Commercial flights, ~7k global |
| military.js | military | ADSB / airplanes.live | Military aircraft |
| traffic.js | traffic | Overpass API | OSM road particle system |
| cameras.js | cameras | Caltrans D4 CWWP2 | Bay Area CCTV feeds |
| maritime.js | maritime | aisstream.io (via Electron) | AIS ship tracking |

---

## Conflict Monitor Layers (not in main.js)

These layers are used only when Conflict Monitor mode is active. They listen to `ea:conflict:tick` and show/hide based on `tMinutes`. To use them, register in main.js when Conflict Monitor is wired up:

| File | id | Purpose |
|------|-----|---------|
| gpsJamming.js | gpsJamming | Red cylinders for GPS jam zones |
| airspaceClosure.js | airspaceClosure | Pink polygons for closed airspace |
| groundTruthCards.js | groundTruth | Floating HTML cards for events |

---

## Layer Implementation Patterns

### Billboard-based layers (satellites, flights, military, maritime, cameras)

- Use `Cesium.BillboardCollection` for icons
- Use `Cesium.LabelCollection` for optional labels
- Store pickable `id` object on each billboard for click handling
- Dispatch `ea:*-selected` events for HUD info panel

### Entity-based layers (seismic)

- Use `Cesium.CustomDataSource` or `viewer.entities`
- Use `CallbackProperty` for animated opacity (fade in/out)

### Post-processing (shaderMode)

- Uses `Cesium.PostProcessStage` with custom GLSL
- Modes: Normal (pass-through), CRT, NVG, FLIR
- Bloom stage for CRT/NVG

### Particle animation (traffic)

- Uses `PointPrimitiveCollection` + `LabelCollection`
- OSM ways → segments → particles that move along segments
- `requestAnimationFrame` loop for per-frame position updates

---

## Sparse vs Full Detection

Layers that render many items (satellites, flights, maritime, seismic) respect the global **Sparse/Full** toggle:

- **Sparse**: `sparseSample()` or step-based filtering — fewer items, even global distribution
- **Full**: Show everything

Layers listen to `ea:detectPre` (fade out) and `ea:detectChange` (switch mode, fade in).

---

## Adding a New Layer

1. Create `src/layers/myLayer.js`
2. Implement the LayerModule interface
3. In `main.js`, import and add to `layerManager.register([...])`
4. If the layer should appear in the HUD, add to `LAYER_DEFS` in `hud.js` (buildLeftPanel)
5. If the layer has a count badge, add `countId` to LAYER_DEFS and implement `_updateBadge` or expose `_sats`/`_billboards` for `startCountPolling`
