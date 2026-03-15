/**
 * cameras.js — Caltrans D4 CCTV Camera Feeds
 *
 * Displays Bay Area highway CCTV cameras from Caltrans D4 CWWP2. Each camera
 * is a billboard icon on the globe. Click to open a popup with live feed
 * image and location label. Selected camera shows a coverage footprint ellipse.
 * Popup image auto-refreshes every 5 seconds.
 *
 * Data: https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json
 */

import * as Cesium from 'cesium';

// ─── Constants ────────────────────────────────────────────────────────────────

const ENDPOINT          = 'https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json';
const IMAGE_REFRESH_MS  = 5000;
const COVERAGE_RADIUS_M = 180;

function parseRecord(wrapper) {
  const r   = wrapper?.cctv ?? wrapper;
  const loc = r?.location ?? {};
  const img = r?.imageData?.static ?? {};
  return {
    id:        r?.index ?? loc?.locationName ?? 'unknown',
    lat:       parseFloat(loc.latitude),
    lon:       parseFloat(loc.longitude),
    imageUrl:  img.currentImageURL || '',
    streamUrl: r?.imageData?.streamingVideoURL || '',
    label:     loc.nearbyPlace
      ? `${loc.nearbyPlace} — ${loc.route || ''}`.trim()
      : (loc.locationName || 'Camera'),
    active: r?.inService === 'true' || r?.inService === true,
  };
}

const CAMERA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.6)" stroke="cyan" stroke-width="1.5"/>
  <path d="M8 9h1.5L11 7h2l1.5 2H16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zm4 1a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" fill="cyan"/>
</svg>`;
const CAMERA_ICON_URI = `data:image/svg+xml,${encodeURIComponent(CAMERA_ICON_SVG)}`;

// ─── Layer Module ─────────────────────────────────────────────────────────────

export const CamerasLayer = {
  id:      'cameras',
  label:   'CCTV Mesh',
  enabled: false,

  _billboards:      null,
  _cameras:         [],
  _selectedIdx:     null,
  _footprintEntity: null,
  _popup:           null,
  _popupImg:        null,
  _popupLabel:      null,
  _countEl:         null,
  _refreshTimer:    null,
  _clickHandler:    null,
  _viewer:          null,

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  init(viewer) {
    this._viewer     = viewer;
    this._billboards = new Cesium.BillboardCollection();
    viewer.scene.primitives.add(this._billboards);
    this._billboards.show = false;
  },

  async enable(viewer) {
    this._viewer = viewer;
    this._billboards.show = true;

    if (this._cameras.length === 0) {
      await this._fetchCameras();
    }

    this._refreshTimer = setInterval(() => this._refreshImage(), IMAGE_REFRESH_MS);

    this._setupClickHandler(viewer);
    console.log('[cameras] Enabled');
  },

  disable(viewer) {
    this._billboards.show = false;

    clearInterval(this._refreshTimer);
    this._refreshTimer = null;

    if (this._clickHandler) {
      this._clickHandler.destroy();
      this._clickHandler = null;
    }

    // Remove footprint entity
    if (this._footprintEntity) {
      try { viewer.entities.remove(this._footprintEntity); } catch (_) {}
      this._footprintEntity = null;
    }

    // Hide popup
    if (this._popup) {
      this._popup.style.display = 'none';
    }

    // Reset billboard colors
    this._resetBillboardColors();
    this._selectedIdx = null;
  },

  refresh() { this._refreshImage(); },

  // ─── Data Fetching ───────────────────────────────────────────────────────────

  async _fetchCameras() {
    let data;
    try {
      const resp = await fetch(ENDPOINT);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (err) {
      console.warn('[CamerasLayer] fetch failed:', err);
      return;
    }

    // CWWP2 structure: { data: [ { cctv: {...} }, ... ] }
    const records = Array.isArray(data) ? data : (data?.data ?? []);
    this._cameras = records
      .map(parseRecord)
      .filter((c) => c.active && !isNaN(c.lat) && !isNaN(c.lon));

    console.log(`[CamerasLayer] ${this._cameras.length} active cameras.`);

    if (this._countEl) {
      this._countEl.textContent = `${this._cameras.length} active  •  Bay Area highways`;
    }

    this._buildBillboards();
  },

  // ─── Globe Billboards ────────────────────────────────────────────────────────

  _buildBillboards() {
    this._billboards.removeAll();
    for (let i = 0; i < this._cameras.length; i++) {
      const cam = this._cameras[i];
      this._billboards.add({
        // Store index as object so pick detection matches the same pattern as flights/satellites
        id:       { cameraIdx: i },
        position: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, 15),
        image:    CAMERA_ICON_URI,
        width:    24,
        height:   24,
        color:    Cesium.Color.CYAN,
        pixelOffset: new Cesium.Cartesian2(0, -12),
        scaleByDistance:        new Cesium.NearFarScalar(500, 1.5, 200000, 0.4),
        translucencyByDistance: new Cesium.NearFarScalar(500, 1.0, 300000, 0.0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
  },

  _resetBillboardColors() {
    if (!this._billboards || this._billboards.isDestroyed()) return;
    for (let i = 0; i < this._billboards.length; i++) {
      this._billboards.get(i).color = Cesium.Color.CYAN;
    }
  },

  // ─── Click Handler ───────────────────────────────────────────────────────────

  _setupClickHandler(viewer) {
    if (this._clickHandler) this._clickHandler.destroy();
    this._clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    this._clickHandler.setInputAction((event) => {
      if (!this.enabled) return;

      const picked = viewer.scene.pick(event.position);
      // Check for a camera billboard: id is an object with cameraIdx property
      if (picked?.id?.cameraIdx == null) return;

      this._selectCamera(picked.id.cameraIdx);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  },

  // ─── Popup ───────────────────────────────────────────────────────────────────

  _buildPopup() {
    if (this._popup) return;

    const popup = document.createElement('div');
    popup.id = 'ea-camera-popup';
    Object.assign(popup.style, {
      position:     'fixed',
      top:          '60px',
      left:         '230px',
      width:        '320px',
      background:   'rgba(6, 10, 8, 0.95)',
      border:       '1px solid rgba(0, 255, 100, 0.35)',
      borderRadius: '3px',
      fontFamily:   "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      color:        '#00ff6a',
      fontSize:     '10px',
      zIndex:       '200',
      boxSizing:    'border-box',
      display:      'none',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      padding:        '8px 10px 6px',
      borderBottom:   '1px solid rgba(0,255,100,0.2)',
    });

    const titleWrap = document.createElement('div');

    const titleEl = document.createElement('div');
    titleEl.textContent = 'CCTV MESH — CALTRANS D4';
    Object.assign(titleEl.style, {
      fontSize:      '11px',
      fontWeight:    'bold',
      letterSpacing: '1.5px',
    });
    titleWrap.appendChild(titleEl);

    const countEl = document.createElement('div');
    countEl.style.cssText = 'font-size:9px; color:rgba(0,255,100,0.55); margin-top:2px;';
    countEl.textContent   = `${this._cameras.length} active  •  Bay Area highways`;
    titleWrap.appendChild(countEl);
    this._countEl = countEl;

    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      cursor:     'pointer',
      fontSize:   '14px',
      color:      'rgba(0,255,100,0.6)',
      lineHeight: '1',
      padding:    '2px 6px',
      userSelect: 'none',
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#fff'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'rgba(0,255,100,0.6)'; });
    closeBtn.addEventListener('click', () => this._closePopup());

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Feed image
    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = 'background:#030806;';

    const img = document.createElement('img');
    Object.assign(img.style, {
      width:     '100%',
      display:   'block',
      maxHeight: '220px',
      objectFit: 'cover',
    });
    img.onerror = () => { img.style.minHeight = '120px'; };
    imgWrap.appendChild(img);
    popup.appendChild(imgWrap);
    this._popupImg = img;

    // Label bar
    const labelEl = document.createElement('div');
    Object.assign(labelEl.style, {
      padding:       '5px 8px 7px',
      fontSize:      '9px',
      color:         'rgba(0,255,100,0.85)',
      background:    'rgba(0,0,0,0.5)',
      letterSpacing: '0.5px',
    });
    popup.appendChild(labelEl);
    this._popupLabel = labelEl;

    document.body.appendChild(popup);
    this._popup = popup;
  },

  _showPopup(cam) {
    this._buildPopup();
    if (this._countEl) {
      this._countEl.textContent = `${this._cameras.length} active  •  Bay Area highways`;
    }
    this._popupImg.src         = `${cam.imageUrl}?t=${Date.now()}`;
    this._popupLabel.textContent = cam.label;
    this._popup.style.display  = 'block';
  },

  _closePopup() {
    if (this._popup) this._popup.style.display = 'none';

    // Reset highlighted billboard
    this._resetBillboardColors();
    this._selectedIdx = null;

    // Remove footprint
    if (this._footprintEntity && this._viewer) {
      try { this._viewer.entities.remove(this._footprintEntity); } catch (_) {}
      this._footprintEntity = null;
    }
  },

  // ─── Image Refresh ───────────────────────────────────────────────────────────

  _refreshImage() {
    if (this._selectedIdx === null) return;
    if (!this._popupImg?.src) return;
    if (this._popup?.style.display === 'none') return;

    const base = this._popupImg.src.split('?')[0];
    if (base) this._popupImg.src = `${base}?t=${Date.now()}`;
  },

  // ─── Camera Selection ────────────────────────────────────────────────────────

  _selectCamera(idx) {
    const cam = this._cameras[idx];
    if (!cam) return;

    this._selectedIdx = idx;

    // Highlight selected, reset others
    for (let i = 0; i < this._billboards.length; i++) {
      this._billboards.get(i).color =
        i === idx ? Cesium.Color.YELLOW : Cesium.Color.CYAN;
    }

    this._showPopup(cam);
    this._updateFootprint(cam);
  },

  // ─── Coverage Footprint ──────────────────────────────────────────────────────

  _updateFootprint(cam) {
    if (this._footprintEntity) {
      try { this._viewer.entities.remove(this._footprintEntity); } catch (_) {}
      this._footprintEntity = null;
    }

    this._footprintEntity = this._viewer.entities.add({
      name:     `camera_footprint_${cam.id}`,
      position: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, 2),
      ellipse: {
        semiMajorAxis: COVERAGE_RADIUS_M,
        semiMinorAxis: COVERAGE_RADIUS_M * 0.7,
        height:        0,
        outline:       true,
        outlineColor:  Cesium.Color.YELLOW.withAlpha(0.75),
        outlineWidth:  2,
        fill:          false,
        numberOfVerticalLines: 0,
        classificationType: Cesium.ClassificationType.TERRAIN,
      },
    });
  },
};
