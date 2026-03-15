/**
 * electron/main.js — Electron Main Process
 *
 * Responsibilities:
 * - Create BrowserWindow (1600×1000, hidden title bar for macOS)
 * - Load .env into process.env (Vite only injects VITE_* into renderer)
 * - AIS proxy: WebSocket to aisstream.io → local HTTP server on :17853
 *   - GET / returns { ships: [...] }
 *   - GET /trail?mmsi=XXX returns position history for a ship
 * - Relax CSP for Cesium/WebSocket
 *
 * The AIS proxy runs only when VITE_AISSTREAM_KEY is set. The maritime layer
 * polls http://127.0.0.1:17853 from the renderer. In web-only builds, the
 * maritime layer will fail to fetch (no proxy).
 */

import { app, BrowserWindow, session, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  // Try project dir (dev) first, then userData (packaged app — user copies .env there)
  const paths = [
    path.join(__dirname, '..', '.env'),
    path.join(app.getPath('userData'), '.env'),
  ];
  for (const envPath of paths) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
      console.log('[env] Loaded from:', envPath);
      break;
    } catch (_) {}
  }
  if (!process.env.VITE_AISSTREAM_KEY) {
    console.warn('[env] VITE_AISSTREAM_KEY not set — Maritime AIS will show 0 ships. For packaged app, copy .env to:', app.getPath('userData'));
  }
}
process.env.VITE_GOOGLE_MAPS_KEY = process.env.VITE_GOOGLE_MAPS_KEY || '';

let win;

// ─── AIS proxy: main process WebSocket → local HTTP endpoint ──────────────
const aisShips = new Map();    // mmsi → latest position
const aisTrails = new Map();   // mmsi → [{ lat, lon, ts }, ...] (up to 24h of history)
const TRAIL_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const TRAIL_SAMPLE_INTERVAL = 30_000;       // store a trail point every 30s
const AIS_PORT = 17853;

function aisStartLocalServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, `http://127.0.0.1:${AIS_PORT}`);

    // /trail?mmsi=XXXXX — return position history for a specific ship
    if (url.pathname === '/trail') {
      const mmsi = url.searchParams.get('mmsi');
      const trail = aisTrails.get(mmsi) || [];
      res.end(JSON.stringify({ mmsi, trail, count: trail.length }));
      return;
    }

    // Default: return all ships
    const cutoff = Date.now() - 600_000;
    for (const [k, v] of aisShips) { if (v.ts < cutoff) aisShips.delete(k); }
    const ships = [...aisShips.values()];
    res.end(JSON.stringify({ ships, total: ships.length }));
  });
  srv.listen(AIS_PORT, '127.0.0.1', () => {
    console.log(`[ais-proxy] Local server: http://127.0.0.1:${AIS_PORT}`);
  });
}

let _aisBackoff = 5000;

function aisConnectWS(apiKey) {
  console.log('[ais-proxy] Connecting to aisstream.io...');
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  let gotMessage = false;

  ws.on('open', () => {
    const payload = {
      APIKey: apiKey.trim(),
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport'],
    };
    console.log('[ais-proxy] Connected! Sending:', JSON.stringify(payload));
    ws.send(JSON.stringify(payload));
  });

  ws.on('message', (raw) => {
    try {
      if (!gotMessage) { gotMessage = true; _aisBackoff = 5000; }
      const data = JSON.parse(raw.toString());
      if (data.error) {
        console.warn('[ais-proxy] server error:', data.error);
      } else if (data.MessageType !== 'PositionReport') {
        console.log('[ais-proxy] non-position msg:', JSON.stringify(data).slice(0, 300));
      }
      if (data.MessageType === 'PositionReport') {
        const pr = data.Message?.PositionReport || {};
        const meta = data.MetaData || {};
        const mmsi = String(pr.UserID || pr.MMSI || meta.MMSI || '');
        if (mmsi && pr.Latitude != null && pr.Longitude != null) {
          const now = Date.now();
          aisShips.set(mmsi, {
            mmsi,
            name: (meta.ShipName || `VESSEL-${mmsi}`).trim(),
            shipType: meta.ShipType,
            lat: pr.Latitude,
            lon: pr.Longitude,
            heading: pr.TrueHeading ?? pr.Cog ?? 0,
            speed: pr.Sog ?? 0,
            ts: now,
          });

          // Store trail history (sample every TRAIL_SAMPLE_INTERVAL)
          let trail = aisTrails.get(mmsi);
          if (!trail) { trail = []; aisTrails.set(mmsi, trail); }
          const lastPt = trail[trail.length - 1];
          if (!lastPt || (now - lastPt.ts) >= TRAIL_SAMPLE_INTERVAL) {
            trail.push({ lat: pr.Latitude, lon: pr.Longitude, ts: now });
            // Prune points older than 24h
            const cutoff = now - TRAIL_MAX_AGE;
            while (trail.length > 0 && trail[0].ts < cutoff) trail.shift();
          }
        }
      }
      // Log ship count periodically
      if (aisShips.size % 100 === 0 && aisShips.size > 0) {
        console.log(`[ais-proxy] ${aisShips.size} ships buffered`);
      }
    } catch (e) { console.warn('[ais-proxy] message parse error:', e.message); }
  });

  ws.on('error', (err) => {
    console.warn('[ais-proxy] WS error:', err.message);
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString('utf8') : '';
    console.warn(`[ais-proxy] WS closed (code: ${code}${reasonStr ? ', reason: ' + reasonStr : ''}) — reconnecting in ${(_aisBackoff / 1000).toFixed(0)}s`);
    setTimeout(() => aisConnectWS(apiKey), _aisBackoff);
    _aisBackoff = Math.min(_aisBackoff * 2, 120000); // backoff up to 2 min
  });
}

ipcMain.handle('ais:port', () => AIS_PORT);

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: false,
    },
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src * ws: wss: 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * ws: wss:;"
        ],
      },
    });
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.on('certificate-error', (event, _wc, _url, _err, _cert, cb) => {
  event.preventDefault();
  cb(true);
});

app.whenReady().then(() => {
  loadEnv();

  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-certificate-errors');

  aisStartLocalServer();
  const aisKey = process.env.VITE_AISSTREAM_KEY || '';
  if (aisKey) {
    aisConnectWS(aisKey);
  } else {
    console.log('[ais-proxy] No VITE_AISSTREAM_KEY — AIS proxy disabled');
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
