import path from "node:path";

export function resolveDesktopServerDirectory({
  isPackaged,
  resourcesPath,
  projectRoot,
}) {
  return isPackaged
    ? path.join(resourcesPath, "app-server.asar")
    : path.join(projectRoot, "dist", "standalone");
}

export function isTrustedAppNavigation(targetUrl, appOrigin) {
  try {
    return new URL(targetUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

export function isExternalHttpUrl(targetUrl) {
  try {
    const protocol = new URL(targetUrl).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === "string") {
    return releaseNotes.trim();
  }
  if (!Array.isArray(releaseNotes)) {
    return "";
  }
  return releaseNotes
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof item.note === "string") {
        return item.note;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function updaterErrorMessage(error) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "更新服务发生未知错误";
}
