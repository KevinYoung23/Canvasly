import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import {
  DESKTOP_PROJECT_FILE_NAME,
  normalizeProjectSnapshot,
  readProjectSnapshot,
  writeProjectSnapshot,
  writeProjectSnapshotSync,
} from "./project-state.mjs";
import {
  isExternalHttpUrl,
  isTrustedAppNavigation,
  normalizeReleaseNotes,
  resolveDesktopServerDirectory,
  updaterErrorMessage,
} from "./runtime-utils.mjs";

const { autoUpdater } = electronUpdater;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const developmentUrl = process.env.CANVASLY_DESKTOP_URL?.trim() || "";
const smokeTest = process.argv.includes("--smoke-test");

let mainWindow = null;
let localServer = null;
let appOrigin = "";
let updateTimer = null;
let projectSaveGeneration = 0;
let projectSaveQueue = Promise.resolve();
let updateState = {
  status: app.isPackaged ? "idle" : "unsupported",
  currentVersion: app.getVersion(),
  message: app.isPackaged
    ? "可以检查 GitHub Releases 中的新版本"
    : "开发模式不执行自动更新",
};

function logFilePath() {
  return path.join(app.getPath("logs"), "canvasly-desktop.log");
}

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
  void mkdir(path.dirname(logFilePath()), { recursive: true })
    .then(() => appendFile(logFilePath(), `${line}\n`, "utf8"))
    .catch((error) => console.error("[Canvasly] Failed to write desktop log", error));
}

function projectFilePath() {
  return path.join(app.getPath("userData"), DESKTOP_PROJECT_FILE_NAME);
}

function queueProjectSave(snapshot) {
  const validatedSnapshot = normalizeProjectSnapshot(snapshot);
  const generation = ++projectSaveGeneration;
  const operation = projectSaveQueue.then(() =>
    writeProjectSnapshot(projectFilePath(), validatedSnapshot, {
      shouldCommit: () => generation === projectSaveGeneration,
    }));
  projectSaveQueue = operation.catch((error) => {
    log("error", `Desktop project save failed: ${updaterErrorMessage(error)}`);
  });
  return operation;
}

function saveProjectBeforeUnload(snapshot) {
  const validatedSnapshot = normalizeProjectSnapshot(snapshot);
  projectSaveGeneration += 1;
  writeProjectSnapshotSync(projectFilePath(), validatedSnapshot);
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? "";
  if (!appOrigin || !isTrustedAppNavigation(senderUrl, appOrigin)) {
    throw new Error("拒绝来自非 Canvasly 页面桌面请求");
  }
}

function publishUpdateState(nextState) {
  updateState = {
    currentVersion: app.getVersion(),
    ...nextState,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:update:state", updateState);
  }
}

function configureUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = app.getVersion().includes("-");
  autoUpdater.fullChangelog = true;
  autoUpdater.logger = {
    info: (message) => log("info", `[updater] ${String(message)}`),
    warn: (message) => log("warn", `[updater] ${String(message)}`),
    error: (message) => log("error", `[updater] ${String(message)}`),
    debug: (message) => log("debug", `[updater] ${String(message)}`),
  };

  autoUpdater.on("checking-for-update", () => {
    publishUpdateState({
      status: "checking",
      message: "正在检查 GitHub Releases…",
    });
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdateState({
      status: "available",
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      message: `发现 Canvasly ${info.version}`,
    });
  });
  autoUpdater.on("update-not-available", () => {
    publishUpdateState({
      status: "not-available",
      message: "当前已是最新版本",
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishUpdateState({
      status: "downloading",
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      message: `正在下载 ${Math.round(progress.percent)}%`,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateState({
      status: "downloaded",
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      message: "更新已下载，可以重启安装",
    });
  });
  autoUpdater.on("error", (error) => {
    publishUpdateState({
      status: "error",
      message: updaterErrorMessage(error),
    });
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    publishUpdateState({
      status: "unsupported",
      message: "开发模式不执行自动更新",
    });
    return updateState;
  }
  if (
    updateState.status === "checking" ||
    updateState.status === "downloading" ||
    updateState.status === "downloaded"
  ) {
    return updateState;
  }
  await autoUpdater.checkForUpdates();
  return updateState;
}

function registerDesktopIpc() {
  ipcMain.handle("desktop:get-info", (event) => {
    assertTrustedSender(event);
    return {
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle("desktop:project:load", async (event) => {
    assertTrustedSender(event);
    return readProjectSnapshot(projectFilePath());
  });
  ipcMain.handle("desktop:project:save", async (event, snapshot) => {
    assertTrustedSender(event);
    await queueProjectSave(snapshot);
    return { savedAt: new Date().toISOString() };
  });
  ipcMain.on("desktop:project:save-sync", (event, snapshot) => {
    try {
      assertTrustedSender(event);
      saveProjectBeforeUnload(snapshot);
      event.returnValue = { ok: true };
    } catch (error) {
      const message = updaterErrorMessage(error);
      log("error", `Failed to save project before unload: ${message}`);
      event.returnValue = { ok: false, message };
    }
  });
  ipcMain.handle("desktop:update:get-state", (event) => {
    assertTrustedSender(event);
    return updateState;
  });
  ipcMain.handle("desktop:update:check", async (event) => {
    assertTrustedSender(event);
    return checkForUpdates();
  });
  ipcMain.handle("desktop:update:download", async (event) => {
    assertTrustedSender(event);
    if (updateState.status !== "available") {
      throw new Error("当前没有可下载的更新");
    }
    await autoUpdater.downloadUpdate();
    return updateState;
  });
  ipcMain.handle("desktop:update:install", (event) => {
    assertTrustedSender(event);
    if (updateState.status !== "downloaded") {
      throw new Error("更新尚未下载完成");
    }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { installing: true };
  });
}

async function startLocalServer() {
  if (developmentUrl) {
    appOrigin = new URL(developmentUrl).origin;
    return developmentUrl;
  }

  process.env.NODE_ENV = "production";
  process.env.ALLOW_PRIVATE_LLM_ENDPOINTS ??= "true";
  const serverDirectory = resolveDesktopServerDirectory({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot,
  });
  const vinextServerPath = path.join(
    serverDirectory,
    "node_modules",
    "vinext",
    "dist",
    "server",
    "prod-server.js",
  );
  const outputDirectory = path.join(serverDirectory, "dist");
  if (!existsSync(vinextServerPath) || !existsSync(outputDirectory)) {
    throw new Error(
      `Canvasly desktop server is missing. Expected ${serverDirectory}`,
    );
  }

  const { startProdServer } = await import(pathToFileURL(vinextServerPath).href);
  const started = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: outputDirectory,
  });
  localServer = started.server;
  appOrigin = `http://127.0.0.1:${started.port}`;
  return appOrigin;
}

function configureWindowSecurity(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppNavigation(url, appOrigin)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
  });
}

async function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    title: "Canvasly",
    backgroundColor: "#f7f5fb",
    webPreferences: {
      preload: path.join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  configureWindowSecurity(mainWindow);

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      log(
        "error",
        `Page load failed (${errorCode}) ${errorDescription}: ${validatedUrl}`,
      );
      if (smokeTest) {
        app.exit(1);
      }
    },
  );
  mainWindow.webContents.once("did-finish-load", () => {
    if (smokeTest) {
      void mainWindow.webContents
        .executeJavaScript(
          "window.canvaslyDesktop.getInfo().then((info) => ({ info, title: document.title }))",
        )
        .then(({ info, title }) => {
          if (!info?.version || !title?.includes("Canvasly")) {
            throw new Error("Desktop preload or Canvasly page did not initialize");
          }
          log("info", "Desktop smoke test loaded successfully");
          setTimeout(() => app.quit(), 250);
        })
        .catch((error) => {
          console.error("[Canvasly] Desktop smoke test failed", error);
          app.exit(1);
        });
      return;
    }
    if (app.isPackaged) {
      setTimeout(() => {
        void checkForUpdates().catch((error) => {
          log("warn", `Automatic update check failed: ${updaterErrorMessage(error)}`);
        });
      }, 10_000);
      updateTimer = setInterval(() => {
        void checkForUpdates().catch((error) => {
          log("warn", `Scheduled update check failed: ${updaterErrorMessage(error)}`);
        });
      }, 6 * 60 * 60 * 1000);
      updateTimer.unref?.();
    }
  });
  mainWindow.once("ready-to-show", () => {
    if (!smokeTest) mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(url);
}

async function stopLocalServer() {
  if (!localServer) return;
  const server = localServer;
  localServer = null;
  await new Promise((resolve) => server.close(resolve));
}

async function launch() {
  await app.whenReady();
  app.setAppUserModelId("com.canvasly.desktop");
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "clipboard-sanitized-write");
    },
  );
  configureUpdater();
  const url = await startLocalServer();
  registerDesktopIpc();
  await createMainWindow(url);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (updateTimer) clearInterval(updateTimer);
  });
  app.on("will-quit", () => {
    void stopLocalServer().catch((error) => {
      log("error", `Failed to stop local server: ${updaterErrorMessage(error)}`);
    });
  });
  launch().catch((error) => {
    const message = updaterErrorMessage(error);
    log("error", `Desktop launch failed: ${message}`);
    if (smokeTest) {
      console.error(`[Canvasly] Desktop launch failed: ${message}`);
      app.exit(1);
      return;
    }
    if (app.isReady()) {
      dialog.showErrorBox("Canvasly 无法启动", message);
    }
    app.exit(1);
  });
}
