import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const DESKTOP_PROJECT_SCHEMA_VERSION = 1;
export const DESKTOP_PROJECT_FILE_NAME = "project-state.json";
export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 1;
export const DESKTOP_PREFERENCES_FILE_NAME = "preferences.json";

const MAX_PROJECT_NAME_LENGTH = 200;
const MAX_HISTORY_ENTRIES = 30;
const MAX_HTML_LENGTH = 5 * 1024 * 1024;
const MAX_TOTAL_HTML_LENGTH = 30 * 1024 * 1024;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 200;
const PROVIDER_IDS = new Set([
  "demo",
  "openai",
  "anthropic",
  "qwen",
  "deepseek",
  "copilot",
  "local",
  "custom",
]);
const PROVIDER_PROTOCOLS = new Set([
  "demo",
  "openai-responses",
  "openai-chat",
  "anthropic",
]);
const SENSITIVE_ENDPOINT_QUERY_KEYS = new Set([
  "apikey",
  "xapikey",
  "authorization",
  "accesstoken",
  "auth",
  "key",
  "password",
  "secret",
  "sig",
  "signature",
  "token",
]);

function assertRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("桌面项目数据必须是对象");
  }
  return value;
}

function assertString(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new TypeError(`${label}必须是字符串`);
  }
  if (value.length > maxLength) {
    throw new RangeError(`${label}超过允许大小`);
  }
  return value;
}

export function normalizeProjectSnapshot(value) {
  const snapshot = assertRecord(value);
  if (snapshot.schemaVersion !== DESKTOP_PROJECT_SCHEMA_VERSION) {
    throw new RangeError("桌面项目数据版本不受支持");
  }

  const projectName = assertString(
    snapshot.projectName,
    "项目名称",
    MAX_PROJECT_NAME_LENGTH,
  ).trim() || "未命名页面";

  if (
    !Array.isArray(snapshot.history) ||
    snapshot.history.length === 0 ||
    snapshot.history.length > MAX_HISTORY_ENTRIES
  ) {
    throw new RangeError("版本历史数量无效");
  }
  const history = snapshot.history.map((html, index) =>
    assertString(html, `版本历史 ${index + 1}`, MAX_HTML_LENGTH));

  if (
    !Number.isInteger(snapshot.historyIndex) ||
    snapshot.historyIndex < 0 ||
    snapshot.historyIndex >= history.length
  ) {
    throw new RangeError("当前版本索引无效");
  }

  const codeDraft = assertString(snapshot.codeDraft, "HTML 草稿", MAX_HTML_LENGTH);
  const projectBaseline = assertString(
    snapshot.projectBaseline,
    "项目基线",
    MAX_HTML_LENGTH,
  );
  const savedHtml = assertString(snapshot.savedHtml, "已导出 HTML", MAX_HTML_LENGTH);
  const totalHtmlLength =
    history.reduce((total, html) => total + html.length, 0) +
    codeDraft.length +
    projectBaseline.length +
    savedHtml.length;
  if (totalHtmlLength > MAX_TOTAL_HTML_LENGTH) {
    throw new RangeError("桌面项目总大小超过 30 MB");
  }
  let intentionalBlankFlags;
  if (snapshot.intentionalBlankFlags !== undefined) {
    if (
      !Array.isArray(snapshot.intentionalBlankFlags) ||
      snapshot.intentionalBlankFlags.length !== history.length ||
      snapshot.intentionalBlankFlags.some(
        (value) => typeof value !== "boolean",
      )
    ) {
      throw new RangeError("空白版本标记无效");
    }
    intentionalBlankFlags = [...snapshot.intentionalBlankFlags];
  }

  return {
    schemaVersion: DESKTOP_PROJECT_SCHEMA_VERSION,
    projectName,
    history,
    historyIndex: snapshot.historyIndex,
    codeDraft,
    projectBaseline,
    savedHtml,
    ...(intentionalBlankFlags ? { intentionalBlankFlags } : {}),
    savedAt:
      typeof snapshot.savedAt === "string"
        ? snapshot.savedAt
        : new Date().toISOString(),
  };
}

export function normalizeDesktopPreferences(value) {
  const preferences = assertRecord(value);
  if (
    preferences.schemaVersion !== DESKTOP_PREFERENCES_SCHEMA_VERSION
  ) {
    throw new RangeError("桌面偏好数据版本不受支持");
  }
  const config = assertRecord(preferences.modelConfig);
  const providerId = assertString(config.providerId, "模型服务", 50);
  const protocol = assertString(config.protocol, "请求协议", 50);
  if (!PROVIDER_IDS.has(providerId)) {
    throw new RangeError("模型服务不受支持");
  }
  if (!PROVIDER_PROTOCOLS.has(protocol)) {
    throw new RangeError("请求协议不受支持");
  }
  const baseUrl = assertString(
    config.baseUrl,
    "模型节点地址",
    MAX_ENDPOINT_LENGTH,
  );
  if (baseUrl) {
    let endpoint;
    try {
      endpoint = new URL(baseUrl);
    } catch {
      throw new TypeError("模型节点地址格式不正确");
    }
    if (endpoint.username || endpoint.password) {
      throw new RangeError("包含用户名或密码的模型节点不会保存");
    }
    for (const key of endpoint.searchParams.keys()) {
      const normalizedKey = key
        .toLowerCase()
        .replace(/[-_.]/g, "");
      if (
        SENSITIVE_ENDPOINT_QUERY_KEYS.has(normalizedKey) ||
        /(?:apikey|apitoken|authtoken|accesstoken|accesskey|authkey|clientsecret|credential|password|passwd|privatekey|secret|signature|token)/.test(
          normalizedKey,
        )
      ) {
        throw new RangeError("包含敏感查询参数的模型节点不会保存");
      }
    }
    if (
      endpoint.hash &&
      /(?:api[_-]?key|auth|password|secret|signature|token)/i.test(
        endpoint.hash,
      )
    ) {
      throw new RangeError("包含敏感片段的模型节点不会保存");
    }
  }

  return {
    schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    modelConfig: {
      providerId,
      protocol,
      baseUrl,
      model: assertString(config.model, "模型名称", MAX_MODEL_LENGTH),
    },
    savedAt:
      typeof preferences.savedAt === "string"
        ? preferences.savedAt
        : new Date().toISOString(),
  };
}

async function replaceFile(tempPath, destinationPath) {
  try {
    await rename(tempPath, destinationPath);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(error && typeof error === "object") ||
      !["EEXIST", "EPERM"].includes(error.code)
    ) {
      throw error;
    }
    await rm(destinationPath, { force: true });
    await rename(tempPath, destinationPath);
  }
}

function replaceFileSync(tempPath, destinationPath) {
  try {
    renameSync(tempPath, destinationPath);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(error && typeof error === "object") ||
      !["EEXIST", "EPERM"].includes(error.code)
    ) {
      throw error;
    }
    rmSync(destinationPath, { force: true });
    renameSync(tempPath, destinationPath);
  }
}

export async function readProjectSnapshot(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return normalizeProjectSnapshot(JSON.parse(source));
}

export async function readDesktopPreferences(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return normalizeDesktopPreferences(JSON.parse(source));
}

async function writeNormalizedJson(
  filePath,
  normalizedValue,
  { shouldCommit } = {},
) {
  const source = `${JSON.stringify(normalizedValue)}\n`;
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, source, { encoding: "utf8", mode: 0o600 });
    if (shouldCommit && !shouldCommit()) {
      return false;
    }
    await replaceFile(tempPath, filePath);
    return true;
  } finally {
    await rm(tempPath, { force: true });
  }
}

function writeNormalizedJsonSync(filePath, normalizedValue) {
  const source = `${JSON.stringify(normalizedValue)}\n`;
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(tempPath, source, { encoding: "utf8", mode: 0o600 });
    replaceFileSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function writeProjectSnapshot(filePath, value, options) {
  return writeNormalizedJson(
    filePath,
    normalizeProjectSnapshot(value),
    options,
  );
}

export function writeProjectSnapshotSync(filePath, value) {
  writeNormalizedJsonSync(filePath, normalizeProjectSnapshot(value));
}

export function writeDesktopPreferences(filePath, value, options) {
  return writeNormalizedJson(
    filePath,
    normalizeDesktopPreferences(value),
    options,
  );
}

export function writeDesktopPreferencesSync(filePath, value) {
  writeNormalizedJsonSync(
    filePath,
    normalizeDesktopPreferences(value),
  );
}
