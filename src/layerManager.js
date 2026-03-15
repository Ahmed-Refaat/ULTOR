/**
 * layerManager.js — Layer Lifecycle Controller
 *
 * LayerManager registers and controls all LayerModule instances. Each layer
 * (satellites, flights, maritime, shaders, etc.) implements a standard
 * interface. The manager calls init() once at registration, then enable()/
 * disable() when the user toggles layers in the HUD.
 *
 * LayerModule interface:
 *   - id: string           — Unique key (e.g. 'satellites')
 *   - label: string        — HUD display name
 *   - enabled: boolean     — Default on/off state
 *   - init(viewer)         — One-time setup (create collections, add to scene)
 *   - enable(viewer)       — Turn on: show primitives, start polling
 *   - disable(viewer)      — Turn off: hide primitives, stop polling, cleanup
 *   - refresh()            — Optional: called on each data poll tick
 *
 * Layers are stored in a Map by id. Toggle/enable/disable operate by id.
 */

export class LayerManager {
  constructor(viewer) {
    this.viewer = viewer;
    this.layers = new Map();
  }

  /**
   * Register one or more layer modules. Calls init() on each, stores by id,
   * and enables any that have enabled: true by default.
   */
  register(modules) {
    for (const mod of modules) {
      mod.init(this.viewer);
      this.layers.set(mod.id, mod);
      if (mod.enabled) mod.enable(this.viewer);
    }
  }

  /** Toggle a layer on/off by id. Returns new enabled state. */
  toggle(id) {
    const mod = this.layers.get(id);
    if (!mod) return;
    mod.enabled = !mod.enabled;
    mod.enabled ? mod.enable(this.viewer) : mod.disable(this.viewer);
    return mod.enabled;
  }

  /** Force-enable a layer by id. No-op if already enabled. */
  enable(id) {
    const mod = this.layers.get(id);
    if (!mod || mod.enabled) return;
    mod.enabled = true;
    mod.enable(this.viewer);
  }

  /** Force-disable a layer by id. No-op if already disabled. */
  disable(id) {
    const mod = this.layers.get(id);
    if (!mod || !mod.enabled) return;
    mod.enabled = false;
    mod.disable(this.viewer);
  }

  /** Check if a layer is currently enabled. */
  isEnabled(id) {
    return this.layers.get(id)?.enabled ?? false;
  }

  /** Return all registered layers as an array. */
  getAll() {
    return Array.from(this.layers.values());
  }
}
