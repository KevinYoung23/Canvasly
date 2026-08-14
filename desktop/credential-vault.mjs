import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const DESKTOP_CREDENTIAL_FILE_NAME = "credentials.enc.json";
export const DESKTOP_CREDENTIAL_SCHEMA_VERSION = 1;
export const DESKTOP_CREDENTIAL_SLOTS = Object.freeze([
  "shared-model-api-key",
  "chat-model-api-key",
]);

const SLOT_SET = new Set(DESKTOP_CREDENTIAL_SLOTS);
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BYTES = 128 * 1024;
const MAX_VAULT_FILE_BYTES = 512 * 1024;

function vaultError(code, message) {
  return { ok: false, error: { code, message } };
}

function validateSlot(slot) {
  return typeof slot === "string" && SLOT_SET.has(slot);
}

function validateCredential(value) {
  if (typeof value !== "string") {
    throw new TypeError("凭据必须是字符串");
  }
  const size = Buffer.byteLength(value, "utf8");
  if (size === 0 || size > MAX_CREDENTIAL_BYTES) {
    throw new RangeError("凭据大小必须在 1 字节到 16 KB 之间");
  }
  return value;
}

function normalizeVaultFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("凭据文件不是对象");
  }
  if (value.schemaVersion !== DESKTOP_CREDENTIAL_SCHEMA_VERSION) {
    throw new RangeError("凭据文件版本不受支持");
  }
  if (!value.slots || typeof value.slots !== "object" || Array.isArray(value.slots)) {
    throw new TypeError("凭据槽数据无效");
  }
  const keys = Object.keys(value.slots);
  if (keys.some((slot) => !SLOT_SET.has(slot))) {
    throw new RangeError("凭据文件包含不受支持的槽");
  }
  const slots = {};
  for (const slot of DESKTOP_CREDENTIAL_SLOTS) {
    const ciphertext = value.slots[slot];
    if (ciphertext === undefined) continue;
    if (
      typeof ciphertext !== "string" ||
      ciphertext.length === 0 ||
      ciphertext.length > MAX_CIPHERTEXT_BYTES * 2
    ) {
      throw new TypeError("凭据密文无效");
    }
    const encrypted = Buffer.from(ciphertext, "base64");
    if (
      encrypted.length === 0 ||
      encrypted.length > MAX_CIPHERTEXT_BYTES ||
      encrypted.toString("base64") !== ciphertext
    ) {
      throw new TypeError("凭据密文编码损坏");
    }
    slots[slot] = ciphertext;
  }
  return { schemaVersion: DESKTOP_CREDENTIAL_SCHEMA_VERSION, slots };
}

async function readVaultFile(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      try {
        await rename(`${filePath}.rollback`, filePath);
        source = await readFile(filePath, "utf8");
      } catch (rollbackError) {
        if (
          rollbackError &&
          typeof rollbackError === "object" &&
          rollbackError.code === "ENOENT"
        ) {
          try {
            source = await readFile(filePath, "utf8");
          } catch (retryError) {
            if (
              retryError &&
              typeof retryError === "object" &&
              retryError.code === "ENOENT"
            ) {
              return {
                schemaVersion: DESKTOP_CREDENTIAL_SCHEMA_VERSION,
                slots: {},
              };
            }
            throw retryError;
          }
        } else {
          throw rollbackError;
        }
      }
    } else {
      throw error;
    }
  }
  if (Buffer.byteLength(source, "utf8") > MAX_VAULT_FILE_BYTES) {
    throw new RangeError("凭据文件超过允许大小");
  }
  return normalizeVaultFile(JSON.parse(source));
}

async function replaceFile(tempPath, destinationPath) {
  const rollbackPath = `${destinationPath}.rollback`;
  try {
    await rename(tempPath, destinationPath);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !error ||
      typeof error !== "object" ||
      !["EEXIST", "EPERM"].includes(error.code)
    ) {
      throw error;
    }
    await rm(rollbackPath, { force: true });
    try {
      await rename(destinationPath, rollbackPath);
    } catch (backupError) {
      if (
        backupError &&
        typeof backupError === "object" &&
        backupError.code === "ENOENT"
      ) {
        await rename(tempPath, destinationPath);
        return;
      }
      throw new AggregateError(
        [error, backupError],
        "无法为加密凭据创建回滚副本",
      );
    }
    try {
      await rename(tempPath, destinationPath);
    } catch (replacementError) {
      try {
        await rename(rollbackPath, destinationPath);
      } catch (recoveryError) {
        throw new AggregateError(
          [replacementError, recoveryError],
          `加密凭据替换失败，回滚副本保留在 ${rollbackPath}`,
        );
      }
      throw replacementError;
    }
  }
  await rm(rollbackPath, { force: true });
}

async function writeVaultFile(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await replaceFile(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function encryptionAvailable(safeStorage) {
  try {
    if (safeStorage?.isEncryptionAvailable() !== true) return false;
    if (
      typeof safeStorage.getSelectedStorageBackend === "function" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function unavailableResult(slot) {
  return vaultError(
    "encryption-unavailable",
    `系统安全存储当前不可用，无法访问 ${slot}`,
  );
}

function classifyReadError(error) {
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
    return vaultError("credential-file-corrupt", "加密凭据文件已损坏");
  }
  return vaultError("credential-storage-error", "无法读取加密凭据文件");
}

export function createCredentialVault({ filePath, safeStorage }) {
  if (typeof filePath !== "string" || !filePath) {
    throw new TypeError("凭据文件路径无效");
  }
  let saveQueue = Promise.resolve();

  async function load(slot) {
    if (!validateSlot(slot)) {
      return vaultError("invalid-credential-slot", "凭据槽不受支持");
    }
    if (!encryptionAvailable(safeStorage)) return unavailableResult(slot);
    try {
      return { ok: true, file: await readVaultFile(filePath) };
    } catch (error) {
      return classifyReadError(error);
    }
  }

  function serializeSave(operation) {
    const result = saveQueue.then(operation, operation);
    saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return Object.freeze({
    async status(slot) {
      const loaded = await load(slot);
      if (!loaded.ok) return loaded;
      return {
        ok: true,
        slot,
        available: true,
        exists: typeof loaded.file.slots[slot] === "string",
      };
    },

    async read(slot) {
      const loaded = await load(slot);
      if (!loaded.ok) return loaded;
      const ciphertext = loaded.file.slots[slot];
      if (ciphertext === undefined) {
        return { ok: true, slot, value: null };
      }
      try {
        const value = safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
        validateCredential(value);
        return { ok: true, slot, value };
      } catch {
        return vaultError(
          "credential-decryption-failed",
          `无法解密 ${slot}，密文可能已损坏或属于其他系统账户`,
        );
      }
    },

    async write(slot, value) {
      if (!validateSlot(slot)) {
        return vaultError("invalid-credential-slot", "凭据槽不受支持");
      }
      try {
        validateCredential(value);
      } catch (error) {
        return vaultError(
          "invalid-credential-value",
          error instanceof Error ? error.message : "凭据无效",
        );
      }
      if (!encryptionAvailable(safeStorage)) return unavailableResult(slot);
      return serializeSave(async () => {
        const loaded = await load(slot);
        if (!loaded.ok) return loaded;
        let encrypted;
        try {
          encrypted = safeStorage.encryptString(value);
          if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
            throw new TypeError("empty ciphertext");
          }
        } catch {
          return vaultError(
            "credential-encryption-failed",
            `无法使用系统安全存储加密 ${slot}`,
          );
        }
        try {
          await writeVaultFile(filePath, {
            schemaVersion: DESKTOP_CREDENTIAL_SCHEMA_VERSION,
            slots: {
              ...loaded.file.slots,
              [slot]: encrypted.toString("base64"),
            },
          });
          return { ok: true, slot, exists: true };
        } catch {
          return vaultError("credential-storage-error", "无法保存加密凭据文件");
        }
      });
    },

    async clear(slot) {
      if (!validateSlot(slot)) {
        return vaultError("invalid-credential-slot", "凭据槽不受支持");
      }
      if (!encryptionAvailable(safeStorage)) return unavailableResult(slot);
      return serializeSave(async () => {
        const loaded = await load(slot);
        if (!loaded.ok) return loaded;
        if (!(slot in loaded.file.slots)) {
          return { ok: true, slot, exists: false };
        }
        const slots = { ...loaded.file.slots };
        delete slots[slot];
        try {
          await writeVaultFile(filePath, {
            schemaVersion: DESKTOP_CREDENTIAL_SCHEMA_VERSION,
            slots,
          });
          return { ok: true, slot, exists: false };
        } catch {
          return vaultError("credential-storage-error", "无法更新加密凭据文件");
        }
      });
    },
  });
}
