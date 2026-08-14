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
    loadPreferences: () => ipcRenderer.invoke("desktop:preferences:load"),
    savePreferences: (preferences) =>
      ipcRenderer.invoke("desktop:preferences:save", preferences),
    savePreferencesBeforeUnload: (preferences) =>
      ipcRenderer.sendSync(
        "desktop:preferences:save-sync",
        preferences,
      ),
    loadCollaboration: () =>
      ipcRenderer.invoke("desktop:collaboration:load"),
    quarantineCollaboration: () =>
      ipcRenderer.invoke("desktop:collaboration:quarantine"),
    saveCollaboration: (state) =>
      ipcRenderer.invoke("desktop:collaboration:save", state),
    saveCollaborationBeforeUnload: (state) =>
      ipcRenderer.sendSync(
        "desktop:collaboration:save-sync",
        state,
      ),
    getCredentialStatus: (slot) =>
      ipcRenderer.invoke("desktop:credential:status", slot),
    readCredential: (slot) =>
      ipcRenderer.invoke("desktop:credential:read", slot),
    writeCredential: (slot, value) =>
      ipcRenderer.invoke("desktop:credential:write", slot, value),
    clearCredential: (slot) =>
      ipcRenderer.invoke("desktop:credential:clear", slot),
    storeCollaborationAttachment: (attachment) =>
      ipcRenderer.invoke(
        "desktop:collaboration-attachment:store",
        attachment,
      ),
    readCollaborationAttachment: (reference) =>
      ipcRenderer.invoke(
        "desktop:collaboration-attachment:read",
        reference,
      ),
    deleteCollaborationAttachment: (reference) =>
      ipcRenderer.invoke(
        "desktop:collaboration-attachment:delete",
        reference,
      ),
    getUpdateState: () => ipcRenderer.invoke("desktop:update:get-state"),
    checkForUpdates: () => ipcRenderer.invoke("desktop:update:check"),
    downloadUpdate: () => ipcRenderer.invoke("desktop:update:download"),
    installUpdate: () => ipcRenderer.invoke("desktop:update:install"),
    onUpdateState: (listener) =>
      subscribe("desktop:update:state", listener),
  }),
);
