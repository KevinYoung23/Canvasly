export type DesktopPlatform = "darwin" | "win32" | "linux";

export type DesktopInfo = {
  version: string;
  platform: DesktopPlatform;
  packaged: boolean;
};

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export type DesktopUpdateState = {
  status: DesktopUpdateStatus;
  currentVersion: string;
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message: string;
};

export type DesktopProjectSnapshot = {
  schemaVersion: 1;
  projectName: string;
  history: string[];
  historyIndex: number;
  codeDraft: string;
  projectBaseline: string;
  savedHtml: string;
  savedAt: string;
};

type SaveProjectResult = {
  savedAt: string;
};

type SaveBeforeUnloadResult =
  | { ok: true }
  | { ok: false; message: string };

export type CanvaslyDesktopApi = {
  getInfo(): Promise<DesktopInfo>;
  loadProject(): Promise<DesktopProjectSnapshot | null>;
  saveProject(snapshot: DesktopProjectSnapshot): Promise<SaveProjectResult>;
  saveProjectBeforeUnload(
    snapshot: DesktopProjectSnapshot,
  ): SaveBeforeUnloadResult;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<{ installing: true }>;
  onUpdateState(
    listener: (state: DesktopUpdateState) => void,
  ): () => void;
};

declare global {
  interface Window {
    canvaslyDesktop?: CanvaslyDesktopApi;
  }
}

export function desktopErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "桌面功能发生未知错误";
}

export function formatDesktopBytes(bytes: number | undefined) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
