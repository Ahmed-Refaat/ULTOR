/**
 * hud.js — Head-Up Display (HUD)
 *
 * Builds and manages the entire UI overlay for Ultor:
 * - Top bar: logo, mode badge, recording timestamp, UTC clock, mouse coordinates
 * - Left panel: Data layer toggles (satellites, flights, military, etc.)
 * - Bottom presets bar: Visual mode buttons (Normal/CRT/NVG/FLIR), shader sliders,
 *   detection toggles (Sparse/Full), label toggles (SAT, Ship, Plane)
 * - Playback bar: Conflict Monitor timeline (scrubber, speed, orbit, camera)
 * - Info panel: Popup for selected satellite/flight/ship details
 *
 * Uses CSS variables for a consistent "tactical" green-on-dark aesthetic.
 * Injects styles dynamically to avoid polluting global CSS.
 *
 * Custom events: Listens for ea:satellite-selected, ea:flight-selected, etc.
 * to show the info panel. Dispatches ea:detectPre/ea:detectChange for
 * Sparse/Full mode transitions.
 */

import { setFull, isFull } from './detectMode.js';

// ─── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('ea-hud-styles')) return;
  const s = document.createElement('style');
  s.id = 'ea-hud-styles';
  s.textContent = `
    :root {
      --bg:         rgba(6, 10, 8, 0.92);
      --bg-solid:   #060a08;
      --border:     #1c2e22;
      --green:      #00ff6a;
      --green-dim:  #007733;
      --green-mid:  #00cc44;
      --amber:      #ffcc00;
      --red:        #ff3333;
      --cyan:       #00eeff;
      --text:       #b8dcc4;
      --text-dim:   #3a5542;
      --text-mid:   #6a9a78;
      --font:       'Courier New', 'Lucida Console', monospace;
    }
    .ea-hud * { box-sizing: border-box; }

    /* scanline overlay on all panels */
    .ea-panel {
      position: fixed;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font);
      font-size: 11px;
      z-index: 1000;
      pointer-events: all;
    }
    .ea-panel::after {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg, transparent, transparent 3px,
        rgba(0,255,80,0.012) 3px, rgba(0,255,80,0.012) 4px
      );
      pointer-events: none;
      z-index: 10;
    }

    /* ── Window drag bar (clearance for macOS traffic lights) ── */
    #ea-titlebar {
      position: fixed; top: 0; left: 0; right: 0; height: 16px;
      -webkit-app-region: drag;
      background: rgba(6, 10, 8, 0.92);
      z-index: 10001;
    }

    /* ── Top bar ── */
    #ea-topbar {
      top: 16px; left: 0; right: 0; height: 52px;
      display: flex; flex-direction: row; align-items: stretch;
      border-bottom: 1px solid var(--border);
      border-left: none; border-right: none; border-top: none;
      -webkit-app-region: drag;
    }
    #ea-topbar button, #ea-topbar select, #ea-topbar input {
      -webkit-app-region: no-drag;
    }
    .ea-topbar-logo-col {
      display: flex; align-items: center; justify-content: center;
      padding: 4px 10px 4px 14px;
      flex-shrink: 0;
    }
    .ea-topbar-rows {
      display: flex; flex-direction: column; flex: 1;
      justify-content: center;
    }
    #ea-topbar .row1 {
      display: flex; align-items: center;
      padding: 0 14px;
      gap: 10px;
    }
    #ea-topbar .row2 {
      display: flex; align-items: center;
      padding: 2px 14px 0;
      gap: 16px;
    }
    .ea-topbar-logo {
      height: 42px; width: auto;
      flex-shrink: 0;
      pointer-events: none;
    }
    .ea-title {
      color: var(--green);
      font-size: 15px;
      font-weight: bold;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .ea-mode-badge {
      background: transparent;
      border: 1px solid var(--amber);
      color: var(--amber);
      font-size: 10px;
      font-weight: bold;
      padding: 2px 8px;
      letter-spacing: 0.1em;
    }
    .ea-classify {
      color: var(--text-dim);
      font-size: 9px;
      letter-spacing: 0.12em;
    }
    .ea-mission {
      color: var(--text-dim);
      font-size: 9px;
      letter-spacing: 0.08em;
    }
    .ea-spacer { flex: 1; }
    .ea-rec {
      color: var(--red);
      font-size: 9px;
      letter-spacing: 0.08em;
    }
    .ea-rec::before {
      content: '● ';
      animation: blink 1.2s step-end infinite;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
    .ea-clock { color: var(--text-mid); font-size: 9px; letter-spacing: 0.1em; }
    .ea-coord { color: var(--text-dim); font-size: 9px; letter-spacing: 0.06em; }

    /* ── Left panel ── */
    #ea-left {
      top: 88px; left: 10px;
      width: 210px;
      padding: 8px 0 8px;
    }
    .ea-sec {
      color: var(--text-dim);
      font-size: 8px;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      padding: 4px 12px 5px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 4px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .ea-sec-toggle {
      cursor: pointer; color: var(--text-dim); font-size: 12px;
      width: 16px; height: 16px; display: flex;
      align-items: center; justify-content: center;
      border: 1px solid var(--border); background: none;
      font-family: var(--font); line-height: 1;
      transition: color 0.15s, border-color 0.15s;
    }
    .ea-sec-toggle:hover { color: var(--green); border-color: var(--green-dim); }
    .ea-collapse-body {
      overflow: hidden;
      transition: max-height 0.3s ease, opacity 0.25s ease;
      max-height: 800px; opacity: 1;
    }
    .ea-collapse-body.collapsed {
      max-height: 0; opacity: 0;
    }
    .ea-layer-row {
      display: flex; align-items: center;
      padding: 5px 12px;
      cursor: pointer; gap: 7px;
      transition: background 0.1s;
    }
    .ea-layer-row:hover { background: rgba(0,255,100,0.04); }
    .ea-layer-icon { color: var(--text-mid); font-size: 11px; width: 14px; text-align:center; }
    .ea-layer-name { flex: 1; color: var(--text); font-size: 10px; }
    .ea-layer-name.off { color: var(--text-dim); }
    .ea-layer-badge {
      font-size: 9px;
      padding: 1px 5px;
      border: 1px solid var(--green-dim);
      color: var(--green-mid);
      min-width: 36px;
      text-align: center;
    }
    .ea-layer-badge.off {
      border-color: var(--text-dim);
      color: var(--text-dim);
    }
    .ea-switch {
      width: 28px; height: 13px;
      background: var(--bg-solid);
      border: 1px solid var(--text-dim);
      border-radius: 7px;
      position: relative;
      flex-shrink: 0;
      transition: border-color 0.15s;
    }
    .ea-switch::after {
      content: '';
      position: absolute;
      top: 2px; left: 2px;
      width: 7px; height: 7px;
      background: var(--text-dim);
      border-radius: 50%;
      transition: all 0.15s;
    }
    .ea-switch.on {
      border-color: var(--green);
      box-shadow: 0 0 6px rgba(0,255,106,0.3);
    }
    .ea-switch.on::after {
      left: 17px;
      background: var(--green);
    }

    /* right panel removed — shader controls merged into left panel */
    .ea-prop-row {
      padding: 4px 12px;
      display: flex; flex-direction: column; gap: 3px;
    }
    .ea-prop-label {
      display: flex; justify-content: space-between;
      color: var(--text-dim); font-size: 8px;
      text-transform: uppercase; letter-spacing: 0.15em;
    }
    .ea-prop-label span { color: var(--green-mid); }
    input[type=range].ea-slider {
      width: 100%; height: 2px;
      accent-color: var(--green);
      background: var(--border);
      outline: none; cursor: pointer;
    }
    .ea-select-row {
      display: flex; align-items: center;
      padding: 4px 12px; gap: 8px;
      color: var(--text-dim); font-size: 9px;
      text-transform: uppercase; letter-spacing: 0.1em;
    }
    select.ea-select {
      flex: 1; background: var(--bg-solid);
      border: 1px solid var(--border);
      color: var(--text); font-family: var(--font);
      font-size: 9px; padding: 2px 4px;
      outline: none; cursor: pointer;
    }
    .ea-toggle-row-r {
      display: flex; align-items: center;
      padding: 4px 12px; gap: 8px;
      color: var(--text-dim); font-size: 9px;
      letter-spacing: 0.1em; text-transform: uppercase;
      cursor: pointer;
    }
    .ea-toggle-row-r:hover { color: var(--text); }
    .ea-sep { border: none; border-top: 1px solid var(--border); margin: 6px 0; }

    /* ── Bottom presets bar ── */
    #ea-presets {
      bottom: 18px; left: 0; right: 0;
      height: 78px;
      display: flex; align-items: center;
      padding: 0 16px; gap: 8px;
      border-top: 1px solid var(--border);
      border-bottom: none; border-left: none; border-right: none;
    }
    #ea-attribution {
      position: fixed; bottom: 0; left: 0; right: 0; height: 18px;
      background: rgba(6, 10, 8, 0.92);
      display: flex; align-items: center; justify-content: center;
      color: rgba(100, 110, 105, 0.55);
      font-family: var(--font); font-size: 7.5px;
      letter-spacing: 0.08em;
      z-index: 10000;
      padding: 0 20px;
      gap: 6px;
      border-top: 1px solid rgba(50, 60, 55, 0.3);
    }
    #ea-attribution span { white-space: nowrap; }
    #ea-attribution .ea-attr-sep { color: rgba(100, 110, 105, 0.3); }
    .ea-presets-label {
      color: var(--text-dim); font-size: 8px;
      letter-spacing: 0.2em; text-transform: uppercase;
      writing-mode: horizontal-tb;
      white-space: nowrap; margin-right: 6px;
    }
    .ea-preset-btn {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      width: 58px; height: 52px;
      background: var(--bg-solid);
      border: 1px solid var(--border);
      color: var(--text-dim); font-family: var(--font);
      font-size: 9px; cursor: pointer; gap: 4px;
      letter-spacing: 0.05em;
      transition: all 0.1s;
    }
    .ea-preset-btn:hover { border-color: var(--green-dim); color: var(--text); }
    .ea-preset-btn.active {
      border-color: var(--amber);
      color: var(--amber);
      background: rgba(255,204,0,0.06);
    }
    .ea-preset-icon { font-size: 18px; line-height: 1; }
    .ea-preset-key { color: var(--text-dim); font-size: 8px; }
    .ea-preset-btn.active .ea-preset-key { color: var(--amber); }
    .ea-presets-spacer { flex: 1; }
.ea-detect-wrap {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      width: 260px;
    }
    .ea-detect-btn {
      background: var(--bg-solid);
      border: 1px solid var(--border);
      color: var(--text-dim); font-family: var(--font);
      font-size: 9px; padding: 4px 10px;
      cursor: pointer; letter-spacing: 0.1em;
      text-transform: uppercase;
      transition: all 0.1s;
      text-align: center;
    }
    .ea-detect-btn:hover { border-color: var(--green-dim); color: var(--text); }
    .ea-detect-btn.active {
      border-color: var(--green);
      color: var(--green);
      background: rgba(0,255,106,0.05);
    }

    /* ── Shader controls in bottom bar ── */
    .ea-shader-wrap {
      display: grid;
      grid-template-columns: auto 100px auto auto;
      gap: 3px 8px;
      align-items: center;
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
      padding: 6px 14px;
    }
    .ea-shader-lbl {
      color: var(--text-dim); font-size: 9px;
      text-transform: uppercase; letter-spacing: 0.1em;
      white-space: nowrap;
    }
    .ea-shader-val {
      color: var(--green-mid); font-size: 9px;
      text-align: right; letter-spacing: 0.05em;
    }
    .ea-shader-wrap input[type=range] {
      width: 100%; height: 2px;
      -webkit-appearance: none; appearance: none;
      background: var(--border); outline: none;
    }
    .ea-shader-wrap input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--green); cursor: pointer;
    }
    .ea-shader-toggle {
      grid-column: 4;
      display: flex; align-items: center; gap: 6px;
      cursor: pointer; font-size: 8px; color: var(--text-dim);
      text-transform: uppercase; letter-spacing: 0.1em;
      white-space: nowrap;
    }

    /* ── Playback bar ── */
    #ea-playback-bar {
      bottom: 0; left: 0; right: 0;
      height: auto;
      display: none;
      flex-direction: column;
      gap: 0;
      padding: 5px 14px 6px;
      border-top: 1px solid var(--border);
      border-bottom: none; border-left: none; border-right: none;
    }
    #ea-playback-bar.visible { display: flex; }
    .ea-pb-row {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 0;
      flex-wrap: nowrap;
    }
    .ea-pb-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--green);
      font-family: var(--font);
      font-size: 13px;
      width: 28px; height: 28px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .ea-pb-btn:hover { border-color: var(--green); }
    .ea-pb-btn.active { border-color: var(--green); background: rgba(0,255,106,0.08); }
    .ea-pb-scrub-wrap {
      flex: 1; position: relative; height: 20px;
      display: flex; align-items: center;
      min-width: 120px;
    }
    input[type=range]#ea-pb-scrub {
      width: 100%; accent-color: var(--green);
      background: var(--border); height: 2px; cursor: pointer;
    }
    .ea-pb-event-dot {
      position: absolute;
      width: 6px; height: 6px; border-radius: 50%;
      top: 50%; transform: translateY(-50%);
      pointer-events: none;
    }
    .ea-pb-label {
      color: var(--text-dim); font-size: 9px;
      letter-spacing: 0.12em; text-transform: uppercase;
      white-space: nowrap; flex-shrink: 0;
    }
    .ea-pb-time {
      color: var(--green-mid); font-size: 9px;
      letter-spacing: 0.08em; white-space: nowrap;
      flex-shrink: 0; min-width: 72px;
    }
    .ea-pb-speed-btn {
      background: transparent; border: 1px solid var(--border);
      color: var(--text-dim); font-family: var(--font);
      font-size: 9px; padding: 2px 6px; cursor: pointer;
      letter-spacing: 0.05em; flex-shrink: 0;
    }
    .ea-pb-speed-btn.active { border-color: var(--amber); color: var(--amber); }
    .ea-pb-speed-btn:hover  { border-color: var(--green-dim); color: var(--text); }
    select.ea-pb-select {
      background: var(--bg-solid); border: 1px solid var(--border);
      color: var(--text); font-family: var(--font);
      font-size: 9px; padding: 2px 4px; outline: none;
      cursor: pointer; flex-shrink: 0;
    }
    .ea-pb-cam-btn {
      background: transparent; border: 1px solid var(--border);
      color: var(--text-dim); font-family: var(--font);
      font-size: 9px; padding: 2px 8px; cursor: pointer;
      letter-spacing: 0.06em; text-transform: uppercase; flex-shrink: 0;
    }
    .ea-pb-cam-btn.active { border-color: var(--cyan); color: var(--cyan); }
    .ea-pb-cam-btn:hover   { border-color: var(--green-dim); }
    input[type=range].ea-pb-dist-slider {
      width: 72px; height: 2px;
      accent-color: var(--green); background: var(--border); cursor: pointer;
    }
    .ea-pb-chip {
      display: inline-flex; align-items: center; gap: 4px;
      border: 1px solid var(--border);
      color: var(--text-dim); font-family: var(--font);
      font-size: 9px; padding: 3px 8px; cursor: pointer;
      white-space: nowrap; flex-shrink: 0;
      letter-spacing: 0.05em; background: transparent;
    }
    .ea-pb-chip.active { border-color: var(--green); color: var(--green); }
    .ea-pb-chip:hover  { border-color: var(--green-dim); color: var(--text); }
    .ea-pb-chips-row {
      display: flex; align-items: center; gap: 6px;
      overflow-x: auto; padding-bottom: 2px; flex: 1;
    }
    .ea-pb-chips-row::-webkit-scrollbar { height: 2px; }
    .ea-pb-chips-row::-webkit-scrollbar-thumb { background: var(--border); }
    .ea-pb-legend-row {
      display: flex; align-items: center; gap: 14px;
      padding-top: 2px;
    }
    .ea-pb-legend-item {
      display: flex; align-items: center; gap: 4px;
      font-size: 8px; color: var(--text-dim);
      letter-spacing: 0.06em; white-space: nowrap;
    }
    .ea-pb-legend-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

    /* ── Info panel ── */
    #ea-info {
      bottom: 120px; left: 10px;
      width: 230px; padding: 10px 12px;
      display: none;
    }
    #ea-info.visible { display: block; }
    .ea-info-hdr {
      font-size: 8px; letter-spacing: 0.2em;
      text-transform: uppercase; color: var(--text-dim);
      margin-bottom: 4px;
    }
    .ea-info-name {
      color: var(--green); font-size: 13px;
      font-weight: bold; letter-spacing: 0.05em;
      margin-bottom: 8px; line-height: 1.2;
    }
    .ea-info-kv {
      display: flex; justify-content: space-between;
      padding: 2px 0;
      border-bottom: 1px solid var(--border);
      font-size: 9px;
    }
    .ea-info-kv:last-of-type { border: none; }
    .ea-info-k { color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; }
    .ea-info-v { color: var(--text); }
    .ea-info-x {
      position: absolute; top: 7px; right: 10px;
      background: none; border: none;
      color: var(--text-dim); font-family: var(--font);
      font-size: 14px; cursor: pointer; line-height: 1;
    }
    .ea-info-x:hover { color: var(--red); }
  `;
  document.head.appendChild(s);
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────

function buildTopBar() {
  // Window drag bar for macOS traffic light clearance
  const titlebar = document.createElement('div');
  titlebar.id = 'ea-titlebar';
  document.body.appendChild(titlebar);

  const el = document.createElement('div');
  el.id = 'ea-topbar'; el.className = 'ea-panel';
  el.innerHTML = `
    <div class="ea-topbar-logo-col">
      <img src="${import.meta.env.BASE_URL}ultor-logo.png" class="ea-topbar-logo" alt="">
    </div>
    <div class="ea-topbar-rows">
      <div class="row1">
        <span class="ea-mode-badge" id="ea-mode-badge">Normal</span>
        <span class="ea-spacer"></span>
        <span class="ea-rec" id="ea-rec"><span id="ea-rec-time"></span></span>
      </div>
      <div class="row2">
        <span class="ea-classify">VERSION 1.0 //OPEN SOURCE GEOSPATIAL INTELLIGENCE //</span>
        <span class="ea-mission">BUILT BY SEQUOIA BOUBION-MCKAY</span>
        <span class="ea-spacer"></span>
        <span class="ea-coord" id="ea-coord">LAT -- LON --</span>
        <span class="ea-clock" id="ea-clock">--:--:-- UTC</span>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  setInterval(() => {
    const now = new Date();
    const utc = now.toUTCString().split(' ')[4];
    document.getElementById('ea-clock').textContent = utc + ' UTC';
    document.getElementById('ea-rec-time').textContent =
      now.toISOString().replace('T', ' ').slice(0, 19) + '↑';
  }, 1000);
}

// ─── Left Panel ───────────────────────────────────────────────────────────────

const LAYER_DEFS = [
  { id: 'satellites', label: 'Satellites',    icon: '⊛', countId: 'cnt-sats'    },
  { id: 'flights',    label: 'Live Flights',  icon: '✈', countId: 'cnt-flights' },
  { id: 'military',   label: 'Military',      icon: '⚔', countId: 'cnt-mil'     },
  { id: 'seismic',    label: 'Earthquakes',   icon: '⚡', countId: 'cnt-seis'   },
  { id: 'traffic',    label: 'Street Traffic',icon: '⋯', countId: null          },
  { id: 'cameras',    label: 'CCTV Mesh',     icon: '◉', countId: 'cnt-cam'    },
  { id: 'maritime',   label: 'Maritime AIS',  icon: '⚓', countId: 'cnt-ships'  },
];

function buildLeftPanel(layerManager) {
  const el = document.createElement('div');
  el.id = 'ea-left'; el.className = 'ea-panel';

  let html = `<div class="ea-sec"><span>Data Layers</span><button class="ea-sec-toggle" id="ea-left-toggle">−</button></div>`;
  html += `<div class="ea-collapse-body" id="ea-left-body">`;
  for (const d of LAYER_DEFS) {
    const on = layerManager.isEnabled(d.id);
    html += `
      <div class="ea-layer-row" data-layer="${d.id}">
        <span class="ea-layer-icon">${d.icon}</span>
        <span class="ea-layer-name ${on ? '' : 'off'}" id="lbl-${d.id}">${d.label}</span>
        <span class="ea-layer-badge ${on ? '' : 'off'}" id="${d.countId || 'cnt-'+d.id}">
          ${on ? 'ON' : 'OFF'}
        </span>
        <div class="ea-switch ${on ? 'on' : ''}" id="sw-${d.id}"></div>
      </div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
  document.body.appendChild(el);

  // Collapse/expand toggle
  document.getElementById('ea-left-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const body = document.getElementById('ea-left-body');
    const btn = document.getElementById('ea-left-toggle');
    const collapsed = body.classList.toggle('collapsed');
    btn.textContent = collapsed ? '+' : '−';
  });

  // Track enabled state and grace period so count polling doesn't overwrite ON/OFF too fast
  window._eaLayerBadge = window._eaLayerBadge || { enabled: new Set(), graceUntil: {} };

  el.querySelectorAll('.ea-layer-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.layer;
      const isOn = layerManager.toggle(id);
      document.getElementById(`lbl-${id}`).classList.toggle('off', !isOn);
      document.getElementById(`sw-${id}`).classList.toggle('on', isOn);
      const def = LAYER_DEFS.find(d => d.id === id);
      const badgeId = def?.countId || `cnt-${id}`;
      const badge = document.getElementById(badgeId);
      if (badge) {
        badge.classList.toggle('off', !isOn);
        if (!isOn) {
          badge.textContent = 'OFF';
          window._eaLayerBadge.enabled.delete(id);
          delete window._eaLayerBadge.graceUntil[id];
        } else {
          badge.textContent = 'ON';
          window._eaLayerBadge.enabled.add(id);
          // 3s grace period — keep "ON" visible before numbers can overwrite
          window._eaLayerBadge.graceUntil[id] = Date.now() + 3000;
        }
      }
    });
  });

  // Set initial state for layers that start enabled
  for (const d of LAYER_DEFS) {
    if (layerManager.isEnabled(d.id)) {
      window._eaLayerBadge.enabled.add(d.id);
    }
  }

}

// ─── Bottom Presets Bar ───────────────────────────────────────────────────────

const PRESETS = [
  { mode: 1, icon: '○', label: 'Normal', key: '[1]' },
  { mode: 2, icon: '▦', label: 'CRT',    key: '[2]' },
  { mode: 3, icon: '☽', label: 'NVG',    key: '[3]' },
  { mode: 4, icon: '◈', label: 'FLIR',   key: '[4]' },
];

function buildPresetsBar(layerManager) {
  const viewer = layerManager.viewer;
  const shader = layerManager.layers.get('shaderMode');
  const sats   = layerManager.layers.get('satellites');

  const el = document.createElement('div');
  el.id = 'ea-presets'; el.className = 'ea-panel';

  const btnHtml = PRESETS.map(p => `
    <button class="ea-preset-btn ${p.mode === 1 ? 'active' : ''}" data-mode="${p.mode}">
      <span class="ea-preset-icon">${p.icon}</span>
      <span>${p.label}</span>
      <span class="ea-preset-key">${p.key}</span>
    </button>`).join('');

  el.innerHTML = `
    <span class="ea-presets-label">Style Presets</span>
    ${btnHtml}
    <div class="ea-shader-wrap">
      <span class="ea-shader-lbl" style="grid-row:1;grid-column:1">Bloom</span>
      <input type="range" id="sl-bloom" min="0" max="3" step="0.1" value="0" style="grid-row:1;grid-column:2">
      <span class="ea-shader-val" id="vbloom" style="grid-row:1;grid-column:3">0.0</span>
      <span class="ea-shader-lbl" style="grid-row:2;grid-column:1">Sens</span>
      <input type="range" id="sl-sens" min="0" max="2" step="0.05" value="1.2" style="grid-row:2;grid-column:2">
      <span class="ea-shader-val" id="vsens" style="grid-row:2;grid-column:3">1.2</span>
      <span class="ea-shader-lbl" style="grid-row:3;grid-column:1">Pixel</span>
      <input type="range" id="sl-pix" min="1" max="16" step="1" value="1" style="grid-row:3;grid-column:2">
      <span class="ea-shader-val" id="vpix" style="grid-row:3;grid-column:3">1</span>
      <div class="ea-shader-toggle" id="row-sharpen" style="grid-row:1;grid-column:4">
        <div class="ea-switch" id="sw-sharpen"></div>
        <span>Sharpen</span>
      </div>
      <div class="ea-shader-toggle" id="row-whot" style="grid-row:2;grid-column:4;display:none">
        <div class="ea-switch on" id="sw-whot"></div>
        <span>WHOT</span>
      </div>
    </div>
    <span class="ea-presets-spacer"></span>
    <div class="ea-detect-wrap">
      <button class="ea-detect-btn" id="btn-detect">Detection: Sparse</button>
      <button class="ea-detect-btn" id="btn-labels">SAT Labels: Off</button>
      <button class="ea-detect-btn" id="btn-ship-labels">Ship Labels: Off</button>
      <button class="ea-detect-btn" id="btn-plane-labels">Plane Labels: Off</button>
    </div>
  `;
  document.body.appendChild(el);

  // Attribution bar
  const attr = document.createElement('div');
  attr.id = 'ea-attribution';
  const sep = '<span class="ea-attr-sep">//</span>';
  attr.innerHTML = [
    'Cesium',
    'Google 3D Tiles',
    'OpenStreetMap',
    'airplanes.live',
    'ADSB Exchange',
    'AISstream.io',
    'SatNOGS',
    'USGS Earthquake Hazards',
    'Overpass API',
    'Caltrans CCTV',
    'satellite.js',
  ].map(s => `<span>${s}</span>`).join(sep);
  document.body.appendChild(attr);

  el.querySelectorAll('.ea-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = parseInt(btn.dataset.mode);
      if (shader) shader.setMode(viewer, mode);
    });
  });

  // Detection mode toggle (Sparse = default, Full = everything)
  document.getElementById('btn-detect').addEventListener('click', () => {
    const nowFull = !isFull();
    const btn = document.getElementById('btn-detect');
    btn.textContent = `Detection: ${nowFull ? 'Full' : 'Sparse'}`;
    btn.classList.toggle('active', nowFull);
    // Phase 1: signal layers to fade out current set
    window.dispatchEvent(new CustomEvent('ea:detectPre'));
    // Phase 2: after fade-out, switch mode and let layers fade in new set
    setTimeout(() => {
      setFull(nowFull);
      window.dispatchEvent(new CustomEvent('ea:detectChange', { detail: { full: nowFull } }));
    }, 250);
  });

  // Satellite labels toggle
  let _labels = false;
  document.getElementById('btn-labels').addEventListener('click', () => {
    _labels = !_labels;
    const btn = document.getElementById('btn-labels');
    btn.textContent = `SAT Labels: ${_labels ? 'On' : 'Off'}`;
    btn.classList.toggle('active', _labels);
    if (sats) sats.setLabels(_labels);
  });

  // Ship labels toggle
  let _shipLabels = false;
  const maritime = layerManager.layers.get('maritime');
  document.getElementById('btn-ship-labels').addEventListener('click', () => {
    _shipLabels = !_shipLabels;
    const btn = document.getElementById('btn-ship-labels');
    btn.textContent = `Ship Labels: ${_shipLabels ? 'On' : 'Off'}`;
    btn.classList.toggle('active', _shipLabels);
    if (maritime) maritime.setLabels(_shipLabels);
  });

  // Plane labels toggle (affects both flights and military)
  let _planeLabels = false;
  const flights  = layerManager.layers.get('flights');
  const military = layerManager.layers.get('military');
  document.getElementById('btn-plane-labels').addEventListener('click', () => {
    _planeLabels = !_planeLabels;
    const btn = document.getElementById('btn-plane-labels');
    btn.textContent = `Plane Labels: ${_planeLabels ? 'On' : 'Off'}`;
    btn.classList.toggle('active', _planeLabels);
    if (flights)  flights.setLabels(_planeLabels);
    if (military) military.setLabels(_planeLabels);
  });

  // ── Shader slider + toggle handlers ──
  const traffic = layerManager.layers.get('traffic');
  const sliderBind = (id, vid, key, fmt) => {
    document.getElementById(id).addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById(vid).textContent = fmt ? fmt(v) : v;
      if (shader) shader.setUniform(viewer, key, v);
    });
  };
  sliderBind('sl-bloom', 'vbloom', 'bloom',       v => v.toFixed(1));
  sliderBind('sl-sens',  'vsens',  'sensitivity', v => v.toFixed(2));
  sliderBind('sl-pix',   'vpix',   'pixelation',  v => Math.round(v));

  let _sharpen = false;
  document.getElementById('row-sharpen').addEventListener('click', () => {
    _sharpen = !_sharpen;
    document.getElementById('sw-sharpen').classList.toggle('on', _sharpen);
    if (shader) shader.setUniform(viewer, 'sharpen', _sharpen ? 1.0 : 0.0);
  });

  let _whot = true;
  document.getElementById('row-whot').addEventListener('click', () => {
    _whot = !_whot;
    document.getElementById('sw-whot').classList.toggle('on', _whot);
    if (shader) shader.setUniform(viewer, 'whot', _whot ? 1.0 : 0.0);
  });

  window.addEventListener('ea:modeChange', e => {
    const { mode, label } = e.detail;
    const badge = document.getElementById('ea-mode-badge');
    if (badge && !window.__ea?.conflictMonitor?.active) badge.textContent = label;
    document.getElementById('row-whot').style.display = mode === 4 ? 'flex' : 'none';
    if (traffic?.setMode) traffic.setMode(mode);
    document.querySelectorAll('.ea-preset-btn').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.mode) === mode));
  });
}

// ─── Info Panel ───────────────────────────────────────────────────────────────

function buildInfoPanel() {
  const el = document.createElement('div');
  el.id = 'ea-info'; el.className = 'ea-panel';
  el.innerHTML = `<button class="ea-info-x" id="ea-info-x">×</button>
    <div id="ea-info-body"></div>`;
  document.body.appendChild(el);

  document.getElementById('ea-info-x').addEventListener('click', () =>
    el.classList.remove('visible'));

  function show(type, name, rows) {
    document.getElementById('ea-info-body').innerHTML = `
      <div class="ea-info-hdr">${type}</div>
      <div class="ea-info-name">${name}</div>
      ${rows.map(([k,v]) => `
        <div class="ea-info-kv">
          <span class="ea-info-k">${k}</span>
          <span class="ea-info-v">${v}</span>
        </div>`).join('')}`;
    el.classList.add('visible');
  }

  window.addEventListener('ea:satellite-selected', e => {
    const { name, noradId, country } = e.detail;
    const countryLabels = {
      china:      'China (PRC)',
      russia:     'Russia',
      usa_mil:    'USA Military',
      nato:       'NATO / European',
      commercial: 'Commercial',
    };
    show('Satellite', name, [
      ['NORAD ID', noradId],
      ['Country',  countryLabels[country] || country || '—'],
      ['Status',   'Tracking ●'],
    ]);
  });
  window.addEventListener('ea:flight-selected', e => {
    const { icao24, callsign, altitude, velocity } = e.detail;
    show('Commercial Flight', callsign || icao24, [
      ['ICAO24',   icao24],
      ['Altitude', altitude ? `${Math.round(altitude).toLocaleString()} m` : '—'],
      ['Speed',    velocity ? `${Math.round(velocity)} kt` : '—'],
    ]);
  });
  window.addEventListener('ea:military-selected', e => {
    const { icao, callsign, type, altitude, speed_kt } = e.detail;
    show('Military Aircraft', callsign || icao, [
      ['ICAO',     icao],
      ['Type',     type || '—'],
      ['Altitude', altitude ? `${Math.round(altitude).toLocaleString()} ft` : '—'],
      ['Speed',    speed_kt ? `${Math.round(speed_kt)} kt` : '—'],
    ]);
  });
  window.addEventListener('ea:ship-selected', e => {
    const { mmsi, name, type, lat, lon, speed, heading } = e.detail;
    show('Vessel', name || mmsi, [
      ['MMSI',     mmsi],
      ['Type',     type || '—'],
      ['Position', `${lat.toFixed(4)}, ${lon.toFixed(4)}`],
      ['Speed',    speed ? `${speed.toFixed(1)} kt` : '—'],
      ['Heading',  heading ? `${Math.round(heading)}°` : '—'],
    ]);
  });
}

// ─── Live Counts ──────────────────────────────────────────────────────────────

function startCountPolling(layerManager) {
  setInterval(() => {
    const get = id => layerManager.layers.get(id);
    const badge = window._eaLayerBadge || { enabled: new Set(), graceUntil: {} };
    const now = Date.now();

    // Only update badge if layer is enabled AND grace period has elapsed
    const set = (layerId, countId, val) => {
      if (!badge.enabled.has(layerId)) return;
      if (badge.graceUntil[layerId] && now < badge.graceUntil[layerId]) return;
      const el = document.getElementById(countId);
      if (el) el.textContent = val;
    };

    const sats = get('satellites');
    if (sats?._sats?.length) set('satellites', 'cnt-sats', sats._sats.length.toLocaleString());

    const fl = get('flights');
    if (fl?._billboards) set('flights', 'cnt-flights', fl._billboards.length.toLocaleString());

    const mil = get('military');
    if (mil?._billboards) set('military', 'cnt-mil', mil._billboards.length.toLocaleString());

    const seis = get('seismic');
    if (seis?._viewer) {
      const count = seis._viewer?.entities?.values?.length;
      if (count) set('seismic', 'cnt-seis', count);
    }

    const cam = get('cameras');
    if (cam?._cameras?.length) set('cameras', 'cnt-cam', cam._cameras.length);
  }, 3000);
}

// ─── Mouse coordinate tracker ─────────────────────────────────────────────────

function startCoordTracker(viewer) {
  import('cesium').then(Cesium => {
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction(e => {
      const ray = viewer.camera.getPickRay(e.endPosition);
      if (!ray) return;
      const pos = viewer.scene.globe.pick(ray, viewer.scene);
      if (!pos) return;
      const carto = Cesium.Cartographic.fromCartesian(pos);
      const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(4);
      const lon = Cesium.Math.toDegrees(carto.longitude).toFixed(4);
      const el = document.getElementById('ea-coord');
      if (el) el.textContent = `LAT ${lat}  LON ${lon}`;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  });
}

// ─── Playback Bar ─────────────────────────────────────────────────────────────

const EVENT_TYPE_COLORS = {
  kinetic:        '#ff4444',
  retaliation:    '#ff8800',
  civilian:       '#ffcc00',
  maritime:       '#00aaff',
  airspace:       '#aa44ff',
  escalation:     '#ff44aa',
  infrastructure: '#44ffaa',
};

function _formatPlaybackTime(tMinutes) {
  const totalSec = Math.floor(tMinutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `T+${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function buildPlaybackBar(layerManager) {
  // Lazy import of CONFLICT_EVENTS for dot rendering
  import('./data/conflictEvents.js').then(({ CONFLICT_EVENTS }) => {
    const el = document.createElement('div');
    el.id = 'ea-playback-bar';
    el.className = 'ea-panel';

    const speedDefs = [
      { label: '1m/s',  mult: 1  },
      { label: '3m/s',  mult: 3  },
      { label: '5m/s',  mult: 5  },
      { label: '15m/s', mult: 15 },
      { label: '1h/s',  mult: 60 },
    ];

    const chipDefs = [
      { layer: 'flights',        label: '✈ Commercial Flights' },
      { layer: 'military',       label: '★ Military Flights'   },
      { layer: 'gpsJamming',     label: '◈ GPS Jamming'        },
      { layer: 'groundTruth',    label: '☰ Ground Truth Cards' },
      { layer: 'satellites',     label: '⊛ Imaging Satellites' },
      { layer: 'maritime',       label: '⚓ Maritime Traffic'   },
      { layer: 'airspaceClosure',label: '✕ Airspace Closures'  },
      { layer: 'vhf',            label: '~ VHF Intercept'      },
    ];

    const legendItems = [
      { type: 'kinetic',        label: 'Kinetic'          },
      { type: 'retaliation',    label: 'Retaliation'      },
      { type: 'civilian',       label: 'Civilian Impact'  },
      { type: 'maritime',       label: 'Maritime'         },
      { type: 'infrastructure', label: 'Infrastructure'   },
      { type: 'escalation',     label: 'Escalation'       },
      { type: 'airspace',       label: 'Airspace Closure' },
    ];

    const speedBtns = speedDefs.map((s, i) =>
      `<button class="ea-pb-speed-btn${i === 0 ? ' active' : ''}" data-mult="${s.mult}">${s.label}</button>`
    ).join('');

    const chipBtns = chipDefs.map(c =>
      `<button class="ea-pb-chip active" data-layer="${c.layer}">${c.label}</button>`
    ).join('');

    const legendHtml = legendItems.map(l =>
      `<span class="ea-pb-legend-item">
        <span class="ea-pb-legend-dot" style="background:${EVENT_TYPE_COLORS[l.type] || '#888'}"></span>
        ${l.label}
      </span>`
    ).join('');

    el.innerHTML = `
      <div class="ea-pb-row">
        <button class="ea-pb-btn" id="ea-pb-play">&#9654;</button>
        <span class="ea-pb-time" id="ea-pb-time">T+00:00:00</span>
        <div class="ea-pb-scrub-wrap">
          <input type="range" id="ea-pb-scrub" min="0" max="120" step="0.1" value="0">
          <div id="ea-pb-dots"></div>
        </div>
        <span class="ea-pb-label">T+02:00</span>
      </div>
      <div class="ea-pb-row">
        <span class="ea-pb-label">SPEED:</span>
        ${speedBtns}
        <span class="ea-pb-label" style="margin-left:6px">ORBIT:</span>
        <button class="ea-pb-btn" id="ea-pb-orbit" style="width:auto;padding:0 8px;font-size:9px;letter-spacing:0.08em">OFF</button>
        <span class="ea-pb-label" id="ea-pb-orbit-spd">3&deg;/s</span>
        <select class="ea-pb-select" id="ea-pb-target">
          <option value="tehran">Tehran</option>
          <option value="bahrain">Bahrain</option>
          <option value="uae">UAE</option>
          <option value="kuwait">Kuwait</option>
        </select>
        <button class="ea-pb-cam-btn" data-cam="flat">FLAT</button>
        <button class="ea-pb-cam-btn" data-cam="spiral_in">SPIRAL IN</button>
        <button class="ea-pb-cam-btn" data-cam="spiral_out">SPIRAL OUT</button>
        <span class="ea-pb-label" style="margin-left:6px" id="ea-pb-alt-label">250km</span>
        <input type="range" class="ea-pb-dist-slider" id="ea-pb-dist" min="50" max="1000" step="10" value="250">
        <span class="ea-pb-label">-45&deg;</span>
        <span class="ea-pb-label">60&deg; FOV</span>
      </div>
      <div class="ea-pb-row">
        <div class="ea-pb-chips-row">${chipBtns}</div>
      </div>
      <div class="ea-pb-legend-row">${legendHtml}</div>
    `;
    document.body.appendChild(el);

    // Position event dots on the scrubber after DOM is rendered
    requestAnimationFrame(() => _placeEventDots(CONFLICT_EVENTS));

    // ── Play/Pause ──
    const playBtn = document.getElementById('ea-pb-play');
    playBtn.addEventListener('click', () => {
      const cm = window.__ea?.conflictMonitor;
      if (!cm) return;
      if (cm.playing) {
        cm.pause();
        playBtn.innerHTML = '&#9654;';
      } else {
        cm.play();
        playBtn.innerHTML = '&#9646;&#9646;';
      }
    });

    // ── Scrubber input ──
    document.getElementById('ea-pb-scrub').addEventListener('input', e => {
      const cm = window.__ea?.conflictMonitor;
      if (!cm) return;
      cm.seek(parseFloat(e.target.value));
    });

    // ── Speed buttons ──
    el.querySelectorAll('.ea-pb-speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.ea-pb-speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        window.__ea?.conflictMonitor?.setSpeed(parseFloat(btn.dataset.mult));
      });
    });

    // ── Orbit toggle ──
    let _orbitOn = false;
    document.getElementById('ea-pb-orbit').addEventListener('click', () => {
      const cm = window.__ea?.conflictMonitor;
      if (!cm) return;
      _orbitOn = !_orbitOn;
      const btn = document.getElementById('ea-pb-orbit');
      btn.textContent = _orbitOn ? 'ON' : 'OFF';
      btn.classList.toggle('active', _orbitOn);
      cm.setOrbit(_orbitOn);
    });

    // ── Target dropdown ──
    document.getElementById('ea-pb-target').addEventListener('change', e => {
      window.__ea?.conflictMonitor?.setTarget(e.target.value);
    });

    // ── Camera preset buttons ──
    el.querySelectorAll('.ea-pb-cam-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.ea-pb-cam-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cm = window.__ea?.conflictMonitor;
        if (!cm) return;
        const cam = btn.dataset.cam;
        if (cam === 'flat')       cm.flyFlat();
        if (cam === 'spiral_in')  cm.flySpiralIn();
        if (cam === 'spiral_out') cm.flySpiralOut();
      });
    });

    // ── Distance slider ──
    document.getElementById('ea-pb-dist').addEventListener('input', e => {
      const km = parseInt(e.target.value);
      document.getElementById('ea-pb-alt-label').textContent = `${km}km`;
      window.__ea?.conflictMonitor?.setAltitude(km);
    });

    // ── Layer filter chips ──
    el.querySelectorAll('.ea-pb-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        const active = chip.classList.contains('active');
        window.dispatchEvent(new CustomEvent('ea:conflict:layer-toggle', {
          detail: { layer: chip.dataset.layer, active },
        }));
      });
    });

    // ── Tick → scrubber + time display ──
    window.addEventListener('ea:conflict:tick', e => {
      const t = e.detail.tMinutes;
      const scrub = document.getElementById('ea-pb-scrub');
      if (scrub) scrub.value = t;
      const timeEl = document.getElementById('ea-pb-time');
      if (timeEl) timeEl.textContent = _formatPlaybackTime(t);
    });

    // Re-place dots when scrubber resizes
    window.addEventListener('resize', () => {
      _placeEventDots(CONFLICT_EVENTS);
    });
  });
}

function _placeEventDots(events) {
  const dotsContainer = document.getElementById('ea-pb-dots');
  const scrub = document.getElementById('ea-pb-scrub');
  if (!dotsContainer || !scrub) return;

  dotsContainer.innerHTML = '';
  Object.assign(dotsContainer.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none',
  });

  const trackW = scrub.offsetWidth;
  const thumbHalf = 6; // approximate half-thumb width for offset
  const usable = trackW - thumbHalf * 2;

  for (const ev of events) {
    const pct = ev.t / 120;
    const left = thumbHalf + pct * usable;
    const dot = document.createElement('span');
    dot.className = 'ea-pb-event-dot';
    dot.style.left = left + 'px';
    dot.style.background = EVENT_TYPE_COLORS[ev.type] || '#888';
    dotsContainer.appendChild(dot);
  }
}

// ─── Conflict mode activation/deactivation ────────────────────────────────────

let _savedModeLabel = 'NORMAL';

// Conflict-specific layer IDs that get auto-enabled when conflict mode activates
const _CONFLICT_LAYER_IDS = ['gpsJamming', 'airspaceClosure', 'groundTruth', 'maritime'];

function _setLayerSwitchUI(id, isOn) {
  document.getElementById(`lbl-${id}`)?.classList.toggle('off', !isOn);
  document.getElementById(`sw-${id}`)?.classList.toggle('on', isOn);
  const badge = document.getElementById(`cnt-${id}`);
  if (badge) {
    badge.classList.toggle('off', !isOn);
    badge.textContent = isOn ? 'ON' : 'OFF';
  }
}

function _setupConflictModeListeners(layerManager) {
  // Topbar toggle button
  const toggleBtn = document.getElementById('ea-conflict-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      window.__ea?.conflictMonitor?.toggle();
    });
  }

  // Track current mode label so we can restore it on deactivation
  window.addEventListener('ea:modeChange', e => {
    if (e.detail?.label) _savedModeLabel = e.detail.label;
  });

  // Layers that were off before activation — we restore them on deactivation
  let _autoEnabled = [];

  window.addEventListener('ea:conflict:activated', () => {
    document.getElementById('ea-presets')?.style.setProperty('display', 'none');
    document.getElementById('ea-playback-bar')?.classList.add('visible');
    const badge = document.getElementById('ea-mode-badge');
    if (badge) badge.textContent = 'PLAYBACK';
    const btn = document.getElementById('ea-conflict-toggle');
    if (btn) { btn.style.borderColor = 'var(--amber)'; btn.style.color = 'var(--amber)'; }

    // Auto-enable conflict layers that are currently off
    _autoEnabled = [];
    for (const id of _CONFLICT_LAYER_IDS) {
      if (!layerManager.isEnabled(id)) {
        layerManager.enable(id);
        _autoEnabled.push(id);
        _setLayerSwitchUI(id, true);
      }
    }

    // Reset play button state
    const playBtn = document.getElementById('ea-pb-play');
    if (playBtn) playBtn.innerHTML = '&#9654;';
    // Re-place event dots now that bar is visible
    import('./data/conflictEvents.js').then(({ CONFLICT_EVENTS }) => {
      requestAnimationFrame(() => _placeEventDots(CONFLICT_EVENTS));
    });
  });

  window.addEventListener('ea:conflict:deactivated', () => {
    document.getElementById('ea-presets')?.style.removeProperty('display');
    document.getElementById('ea-playback-bar')?.classList.remove('visible');
    const badge = document.getElementById('ea-mode-badge');
    if (badge) badge.textContent = _savedModeLabel;
    const btn = document.getElementById('ea-conflict-toggle');
    if (btn) { btn.style.borderColor = 'var(--text-dim)'; btn.style.color = 'var(--text-dim)'; }

    // Restore auto-enabled layers back to off
    for (const id of _autoEnabled) {
      layerManager.disable(id);
      _setLayerSwitchUI(id, false);
    }
    _autoEnabled = [];

    // Reset scrubber and time display
    const scrub = document.getElementById('ea-pb-scrub');
    if (scrub) scrub.value = 0;
    const timeEl = document.getElementById('ea-pb-time');
    if (timeEl) timeEl.textContent = 'T+00:00:00';
    const playBtn = document.getElementById('ea-pb-play');
    if (playBtn) playBtn.innerHTML = '&#9654;';
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initHUD(layerManager) {
  injectStyles();
  buildTopBar();
  buildLeftPanel(layerManager);
  buildPresetsBar(layerManager);
  buildInfoPanel();
  buildPlaybackBar(layerManager);
  _setupConflictModeListeners(layerManager);
  startCountPolling(layerManager);
  startCoordTracker(layerManager.viewer);
}
