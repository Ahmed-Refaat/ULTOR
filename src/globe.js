/**
 * globe.js — CesiumJS 3D Globe Initialization
 *
 * Creates and configures the Cesium viewer with:
 * - Google Photorealistic 3D Tiles (requires VITE_GOOGLE_MAPS_KEY)
 * - OpenStreetMap as base imagery (no key required)
 * - Dark space aesthetic (black background, atmospheric limb glow)
 * - No default Cesium UI chrome (geocoder, home button, etc.)
 *
 * Performance: resolutionScale = 1.0 to avoid 4x pixel count on Retina.
 *
 * @param {string} containerId - DOM element ID for the Cesium container
 * @returns {Promise<Cesium.Viewer>} Configured Cesium viewer instance
 */

import * as Cesium from 'cesium';

/**
 * Initializes the CesiumJS viewer with Google Photorealistic 3D Tiles.
 * Returns the configured viewer instance.
 */
export async function initGlobe(containerId) {
  const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_KEY;

  // Ion token not needed — we use Google tiles directly.
  // Set a blank token (or VITE_CESIUM_TOKEN if provided) to suppress the default warning.
  Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? '';

  const viewer = new Cesium.Viewer(containerId, {
    // Remove all default UI chrome
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    vrButton: false,
    infoBox: false,
    selectionIndicator: false,
    // Suppress credit/logo display
    creditContainer: Object.assign(document.createElement('div'), { style: 'display:none' }),
    // Use our own terrain / imagery
    terrainProvider: undefined,
    imageryProvider: false,
  });

  // Load Google Photorealistic 3D Tiles
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleMapsKey}`,
      {
        showCreditsOnScreen: true,
        // Tune tile loading for performance
        maximumScreenSpaceError: 8,       // lower = sharper but slower; 8 is a good balance
        maximumMemoryUsage: 2048,          // MB — generous for desktop
        skipLevelOfDetail: true,
        skipLevels: 1,
      }
    );
    viewer.scene.primitives.add(tileset);
  } catch (e) {
    console.warn('Google 3D Tiles failed to load. Check VITE_GOOGLE_MAPS_KEY in .env', e);
  }

  // Show the globe with Natural Earth imagery as the base layer.
  // Google 3D Tiles render on top when zoomed in close.
  viewer.scene.globe.show = true;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a0f1a');

  // Add OpenStreetMap as base imagery (no API key required)
  viewer.scene.globe.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      maximumLevel: 19,
    })
  );

  // Dark background
  viewer.scene.backgroundColor = Cesium.Color.BLACK;

  // Keep the atmospheric limb glow for the space view
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.skyAtmosphere.atmosphereLightIntensity = 10.0;

  // Hide the default skybox — we want black space, not the stock star texture
  viewer.scene.skyBox.show = false;

  // Performance — do NOT use devicePixelRatio on Retina displays.
  // 2x scale = 4x pixels rendered = guaranteed poor performance.
  viewer.resolutionScale = 1.0;

  // Default camera: full Earth view
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-100.0, 40.0, 15000000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });

  return viewer;
}
