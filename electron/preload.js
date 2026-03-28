'use strict';
/**
 * StremioPI — Electron preload script
 * Exposes safe IPC bridge to the renderer (tv-app/app.js).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Launch MPV fullscreen with the given stream URL */
  playStream:   (url, title) => ipcRenderer.invoke('player:launch', { url, title }),
  /** Stop the currently playing MPV instance */
  stopStream:   ()           => ipcRenderer.invoke('player:stop'),
  /** Toggle pause/resume in MPV */
  pauseStream:  ()           => ipcRenderer.invoke('player:pause'),
  /** Returns { running: bool } */
  playerStatus: ()           => ipcRenderer.invoke('player:status'),
});
