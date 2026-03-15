/**
 * electron/preload.js — Preload Script (Context Bridge)
 *
 * Exposes safe APIs to the renderer via contextBridge. The renderer runs with
 * contextIsolation and nodeIntegration: false, so it cannot access Node/Electron
 * APIs directly. This script runs in a privileged context and bridges:
 *
 * - isElectron: boolean — true when running in Electron (vs web)
 * - aisPort(): Promise — returns AIS proxy port (for dynamic config)
 *
 * Note: The maritime layer currently hardcodes AIS_PROXY_URL = 'http://127.0.0.1:17853'.
 * aisPort() could be used to make this configurable.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('isElectron', true);
contextBridge.exposeInMainWorld('aisPort', () => ipcRenderer.invoke('ais:port'));
