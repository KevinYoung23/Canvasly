/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Desktop event listener must be a function");
  }
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld(
  "canvaslyDesktop",
  Object.freeze({
    getInfo: () => ipcRenderer.invoke("desktop:get-info"),
    loadProject: () => ipcRenderer.invoke("desktop:project:load"),
    saveProject: (snapshot) =>
      ipcRenderer.invoke("desktop:project:save", snapshot),
    saveProjectBeforeUnload: (snapshot) =>
      ipcRenderer.sendSync("desktop:project:save-sync", snapshot),
    getUpdateState: () => ipcRenderer.invoke("desktop:update:get-state"),
    checkForUpdates: () => ipcRenderer.invoke("desktop:update:check"),
    downloadUpdate: () => ipcRenderer.invoke("desktop:update:download"),
    installUpdate: () => ipcRenderer.invoke("desktop:update:install"),
    onUpdateState: (listener) =>
      subscribe("desktop:update:state", listener),
  }),
);
