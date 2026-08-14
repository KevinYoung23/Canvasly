import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const DESKTOP_COLLABORATION_ATTACHMENTS_DIRECTORY =
  "collaboration-attachments";
export const DESKTOP_ATTACHMENT_SCHEMA_VERSION = 1;
export const MAX_DESKTOP_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_DESKTOP_DOCUMENT_ATTACHMENT_BYTES = 480 * 1024;
export const MAX_DESKTOP_DOCUMENT_ATTACHMENT_CHARACTERS = 120_000;

const REFERENCE_PREFIX = "canvasly-attachment:v1:";
const REFERENCE_PATTERN = /^canvasly-attachment:v1:([a-f0-9]{64})$/;
const MAX_ATTACHMENT_FILE_BYTES =
  Math.ceil((MAX_DESKTOP_IMAGE_ATTACHMENT_BYTES * 4) / 3) + 8 * 1024;
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const DOCUMENT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/xhtml+xml",
]);

class AttachmentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function resultError(code, message, queueMustRemainPaused = false) {
  return {
    ok: false,
    error: { code, message },
    ...(queueMustRemainPaused ? { queueMustRemainPaused: true } : {}),
  };
}

function validationError(message) {
  throw new AttachmentValidationError("invalid-attachment", message);
}

function tooLarge(message) {
  throw new AttachmentValidationError("attachment-too-large", message);
}

function assertRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validationError("附件负载必须是对象");
  }
  return value;
}

function rejectApiKeyFields(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) rejectApiKeyFields(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_.\s]/g, "");
    if (
      normalized.includes("apikey") ||
      normalized.includes("apitoken") ||
      normalized === "authorization"
    ) {
      validationError("附件负载不得包含 API 密钥字段");
    }
    rejectApiKeyFields(item, seen);
  }
}

function boundedString(value, label, maxLength, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength
  ) {
    validationError(`${label}无效`);
  }
  return value;
}

function normalizeId(value) {
  const id = boundedString(value, "附件 ID", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
    validationError("附件 ID 只能包含字母、数字、下划线和连字符");
  }
  return id;
}

function normalizeName(value) {
  const name = boundedString(value, "附件名称", 500);
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    validationError("附件名称包含无效字符");
  }
  return name;
}

function normalizeMimeType(value, kind) {
  const mimeType = boundedString(value, "附件 MIME 类型", 200).toLowerCase();
  if (kind === "image" && !IMAGE_MIME_TYPES.has(mimeType)) {
    validationError("图片附件 MIME 类型不受支持");
  }
  if (
    kind === "document" &&
    !/^text\/[a-z0-9.+-]+$/.test(mimeType) &&
    !DOCUMENT_APPLICATION_MIME_TYPES.has(mimeType)
  ) {
    validationError("文档附件 MIME 类型不受支持");
  }
  return mimeType;
}

function normalizeSize(value, actualSize) {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0 || value !== actualSize)
  ) {
    validationError("附件大小与负载不一致");
  }
  return actualSize;
}

function hasExpectedImageSignature(value, mimeType) {
  if (mimeType === "image/png") {
    return value.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mimeType === "image/jpeg") {
    return value.length >= 3 &&
      value[0] === 0xff &&
      value[1] === 0xd8 &&
      value[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = value.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return (
    mimeType === "image/webp" &&
    value.subarray(0, 4).toString("ascii") === "RIFF" &&
    value.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function normalizeImageData(value, mimeType) {
  if (typeof value !== "string") {
    validationError("图片附件 data URL 无效");
  }
  if (
    value.length >
    Math.ceil((MAX_DESKTOP_IMAGE_ATTACHMENT_BYTES * 4) / 3) + 100
  ) {
    tooLarge("图片附件超过 4 MB");
  }
  const match = value.match(
    /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match || match[1].toLowerCase() !== mimeType) {
    validationError("图片附件必须是 MIME 类型匹配的 base64 data URL");
  }
  const encoded = match[2];
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64") !== encoded
  ) {
    validationError("图片附件 data URL 编码无效");
  }
  if (decoded.length > MAX_DESKTOP_IMAGE_ATTACHMENT_BYTES) {
    tooLarge("图片附件超过 4 MB");
  }
  if (!hasExpectedImageSignature(decoded, mimeType)) {
    validationError("图片附件内容与 MIME 类型不匹配");
  }
  return { data: value, sizeBytes: decoded.length };
}

function normalizeDocumentText(value) {
  if (typeof value !== "string") validationError("文档附件文本无效");
  if (value.length > MAX_DESKTOP_DOCUMENT_ATTACHMENT_CHARACTERS) {
    tooLarge("文档附件文本超过 120,000 个字符");
  }
  const sizeBytes = Buffer.byteLength(value, "utf8");
  if (sizeBytes > MAX_DESKTOP_DOCUMENT_ATTACHMENT_BYTES) {
    tooLarge("文档附件文本超过 480 KB");
  }
  return { text: value, sizeBytes };
}

function normalizePayload(value, reference) {
  rejectApiKeyFields(value);
  const payload = assertRecord(value);
  if (!["image", "document"].includes(payload.kind)) {
    validationError("附件类型必须是 image 或 document");
  }
  const mimeType = normalizeMimeType(payload.mimeType, payload.kind);
  const content =
    payload.kind === "image"
      ? normalizeImageData(payload.data, mimeType)
      : normalizeDocumentText(payload.text);
  if (
    (payload.kind === "image" && payload.text !== undefined) ||
    (payload.kind === "document" && payload.data !== undefined)
  ) {
    validationError("附件负载类型不匹配");
  }
  const sizeBytes = normalizeSize(payload.sizeBytes, content.sizeBytes);
  return {
    id: normalizeId(payload.id),
    name: normalizeName(payload.name),
    mimeType,
    kind: payload.kind,
    ...content,
    sizeBytes,
    ...(payload.sizeLabel === undefined
      ? {}
      : {
          sizeLabel: boundedString(
            payload.sizeLabel,
            "附件大小标签",
            100,
          ),
        }),
    reference,
  };
}

export function parseCollaborationAttachmentReference(value) {
  if (typeof value !== "string") return null;
  const match = value.match(REFERENCE_PATTERN);
  return match ? match[1] : null;
}

export function isCollaborationAttachmentReference(value) {
  return parseCollaborationAttachmentReference(value) !== null;
}

function filePathForReference(directoryPath, reference) {
  const token = parseCollaborationAttachmentReference(reference);
  return token ? path.join(directoryPath, `${token}.json`) : null;
}

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function atomicWrite(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function validationResult(error, fallbackCode = "invalid-attachment") {
  if (error instanceof AttachmentValidationError) {
    return resultError(error.code, error.message);
  }
  return resultError(fallbackCode, "附件负载无效");
}

export function createCollaborationAttachmentStore({ directoryPath }) {
  if (typeof directoryPath !== "string" || directoryPath.length === 0) {
    throw new TypeError("附件存储目录无效");
  }

  return Object.freeze({
    async store(value) {
      let reference;
      let attachment;
      try {
        reference = `${REFERENCE_PREFIX}${randomBytes(32).toString("hex")}`;
        attachment = normalizePayload(value, reference);
      } catch (error) {
        return validationResult(error);
      }
      try {
        await ensureDirectory(directoryPath);
        await atomicWrite(
          filePathForReference(directoryPath, reference),
          {
            schemaVersion: DESKTOP_ATTACHMENT_SCHEMA_VERSION,
            attachment,
          },
        );
        return { ok: true, attachment };
      } catch {
        return resultError(
          "attachment-storage-error",
          "无法保存协作附件",
        );
      }
    },

    async read(reference) {
      const filePath = filePathForReference(directoryPath, reference);
      if (!filePath) {
        return resultError(
          "invalid-attachment-reference",
          "协作附件引用无效",
          true,
        );
      }
      let source;
      try {
        source = await readFile(filePath, "utf8");
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          return resultError(
            "attachment-not-found",
            "协作附件负载不存在",
            true,
          );
        }
        return resultError(
          "attachment-storage-error",
          "无法读取协作附件",
          true,
        );
      }
      if (Buffer.byteLength(source, "utf8") > MAX_ATTACHMENT_FILE_BYTES) {
        return resultError(
          "attachment-corrupt",
          "协作附件文件超过允许大小",
          true,
        );
      }
      try {
        const stored = JSON.parse(source);
        if (
          !stored ||
          typeof stored !== "object" ||
          Array.isArray(stored) ||
          stored.schemaVersion !== DESKTOP_ATTACHMENT_SCHEMA_VERSION ||
          stored.attachment?.reference !== reference
        ) {
          throw new TypeError("invalid stored attachment");
        }
        return {
          ok: true,
          attachment: normalizePayload(stored.attachment, reference),
        };
      } catch {
        return resultError(
          "attachment-corrupt",
          "协作附件负载已损坏",
          true,
        );
      }
    },

    async delete(reference) {
      const filePath = filePathForReference(directoryPath, reference);
      if (!filePath) {
        return resultError(
          "invalid-attachment-reference",
          "协作附件引用无效",
        );
      }
      try {
        await rm(filePath);
        return { ok: true, reference, deleted: true };
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          return { ok: true, reference, deleted: false };
        }
        return resultError(
          "attachment-storage-error",
          "无法删除协作附件",
        );
      }
    },
  });
}
