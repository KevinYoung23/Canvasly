import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  normalizeProjectSnapshot,
  normalizeDesktopPreferences,
  readDesktopPreferences,
  readProjectSnapshot,
  writeDesktopPreferences,
  writeProjectSnapshot,
} from "../desktop/project-state.mjs";
import {
  normalizeCollaborationState,
  quarantineCollaborationState,
  readCollaborationState,
  writeCollaborationState,
  writeCollaborationStateSync,
} from "../desktop/collaboration-state.mjs";
import {
  createCredentialVault,
} from "../desktop/credential-vault.mjs";
import {
  createCollaborationAttachmentStore,
} from "../desktop/collaboration-attachments.mjs";
import {
  isExternalHttpUrl,
  isTrustedAppNavigation,
  normalizeReleaseNotes,
  resolveDesktopServerDirectory,
  updaterErrorMessage,
} from "../desktop/runtime-utils.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testRuntimeRoot = path.join(projectRoot, ".sites-runtime", "tests");

async function makeTestDirectory(prefix) {
  await mkdir(testRuntimeRoot, { recursive: true });
  return mkdtemp(path.join(testRuntimeRoot, prefix));
}

const validSnapshot = {
  schemaVersion: 1,
  projectName: "Landing page",
  history: ["<!doctype html><html></html>"],
  historyIndex: 0,
  codeDraft: "<!doctype html><html></html>",
  projectBaseline: "<!doctype html><html></html>",
  savedHtml: "<!doctype html><html></html>",
  savedAt: "2026-08-14T00:00:00.000Z",
};

const validPreferences = {
  schemaVersion: 1,
  modelConfig: {
    providerId: "custom",
    protocol: "openai-responses",
    baseUrl: "https://models.example.com/v1",
    model: "canvasly-model",
  },
  savedAt: "2026-08-14T00:00:00.000Z",
};

const nonSecretModelConfig = {
  providerId: "custom",
  protocol: "openai-chat",
  baseUrl: "https://models.example.com/v1",
  model: "chat-model",
};
const testAttachmentReference =
  `canvasly-attachment:v1:${"a".repeat(64)}`;

const validCollaborationState = {
  schemaVersion: 1,
  coworkMessages: [
    {
      id: "cowork-1",
      role: "assistant",
      text: "更新已完成",
      plan: {
        strategy: "mission",
        objective: "完成页面发布准备",
        summary: "先检查结构，再验证结果。",
        assumptions: ["现有 HTML 可以编辑"],
        steps: [
          {
            id: "step-1",
            title: "检查页面",
            description: "确认页面结构和待修改区域。",
          },
        ],
        acceptanceCriteria: ["页面结构通过验证"],
        openQuestions: ["是否需要移动端专项检查？"],
      },
      citations: [
        {
          id: "citation-1",
          title: "Design reference",
          url: "https://example.com/design",
        },
      ],
      streamState: "completed",
    },
  ],
  chatMessages: [
    {
      id: "chat-1",
      role: "user",
      text: "讨论导航设计",
    },
  ],
  handoffCards: [
    {
      id: "handoff-1",
      title: "改进导航",
      objective: "让导航更清晰",
      decisions: ["保留三个入口"],
      references: [
        {
          title: "Design reference",
          url: "https://example.com/design",
          note: "参考信息层级",
        },
      ],
      constraints: ["保持移动端布局"],
      openQuestions: [],
      instruction: "重新组织导航",
      sourceMessageIds: ["chat-1"],
      createdAt: "2026-08-14T00:00:00.000Z",
    },
  ],
  coworkQueue: [
    {
      id: "queued-1",
      messageId: "cowork-queued-1",
      mode: "cowork",
      instruction: "更新页脚",
      attachments: [],
      selection: null,
      priority: "queued",
      modelConfig: nonSecretModelConfig,
    },
  ],
  coworkQueuePaused: false,
  coworkStrategy: "mission",
  activeCoworkTask: {
    id: "active-1",
    messageId: "cowork-active-1",
    mode: "cowork",
    instruction: "更新标题",
    attachments: [
      {
        id: "attachment-1",
        name: "brief.txt",
        mimeType: "text/plain",
        kind: "document",
        sizeBytes: 1024,
        sizeLabel: "1 KB",
        reference: testAttachmentReference,
      },
    ],
    selection: null,
    priority: "normal",
    strategy: "mission",
    modelConfig: nonSecretModelConfig,
  },
  panes: {
    cowork: { open: true, width: 410 },
    chat: { open: false, width: 350 },
    activeMobilePane: "chat",
    layout: "switch",
  },
  chatModelOverride: nonSecretModelConfig,
  attachments: {
    cowork: [],
    chat: [],
  },
  savedAt: "2026-08-14T00:00:00.000Z",
};

test("resolves development and packaged server directories", () => {
  assert.equal(
    resolveDesktopServerDirectory({
      isPackaged: false,
      resourcesPath: "/Applications/Canvasly.app/Contents/Resources",
      projectRoot: "/repo",
    }),
    path.join("/repo", "dist", "standalone"),
  );
  assert.equal(
    resolveDesktopServerDirectory({
      isPackaged: true,
      resourcesPath: "/Applications/Canvasly.app/Contents/Resources",
      projectRoot: "/repo",
    }),
    path.join(
      "/Applications/Canvasly.app/Contents/Resources",
      "app-server.asar",
    ),
  );
});

test("migrates omitted Cowork strategies to auto", () => {
  const state = normalizeCollaborationState({
    ...validCollaborationState,
    coworkStrategy: undefined,
    activeCoworkTask: {
      ...validCollaborationState.activeCoworkTask,
      strategy: undefined,
    },
    coworkQueue: validCollaborationState.coworkQueue.map((task) => ({
      ...task,
      strategy: undefined,
    })),
  });

  assert.equal(state.coworkStrategy, "auto");
  assert.deepEqual(
    state.coworkQueue.map((task) => task.strategy),
    ["auto", "auto"],
  );
  assert.deepEqual(
    state.coworkQueue.map((task) => task.interactionMode),
    ["auto", "auto"],
  );
  assert.equal(state.activeMode, "auto");
  assert.equal(state.pane.open, true);
  assert.equal(state.pane.width, 410);
  assert.deepEqual(
    state.unifiedMessages.map((message) => message.id),
    ["cowork-1", "chat-1"],
  );
});

test("legacy dual histories retain a balanced recent window", () => {
  const state = normalizeCollaborationState({
    ...validCollaborationState,
    coworkMessages: Array.from({ length: 200 }, (_, index) => ({
      id: `cowork-${index}`,
      role: "assistant",
      text: `Cowork ${index}`,
    })),
    chatMessages: Array.from({ length: 200 }, (_, index) => ({
      id: `chat-${index}`,
      role: "user",
      text: `Chat ${index}`,
    })),
  });

  assert.equal(state.unifiedMessages.length, 200);
  assert.equal(
    state.unifiedMessages.filter((message) =>
      message.id.startsWith("cowork-"),
    ).length,
    100,
  );
  assert.equal(
    state.unifiedMessages.filter((message) =>
      message.id.startsWith("chat-"),
    ).length,
    100,
  );
});

test("rejects collaboration attachment payloads above the aggregate budget", () => {
  const attachments = Array.from({ length: 8 }, (_, index) => ({
    id: `large-${index}`,
    name: `large-${index}.png`,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 4 * 1024 * 1024,
    sizeLabel: "4 MB",
    reference: `canvasly-attachment:v1:${index
      .toString(16)
      .padStart(64, "0")}`,
  }));
  assert.throws(
    () =>
      normalizeCollaborationState({
        ...validCollaborationState,
        unifiedMessages: [],
        pendingAttachments: attachments,
      }),
    /总大小超过 32 MB/,
  );
});

test("accepts only the local Canvasly origin for app navigation", () => {
  const origin = "http://127.0.0.1:43123";
  assert.equal(isTrustedAppNavigation(`${origin}/settings`, origin), true);
  assert.equal(isTrustedAppNavigation("https://example.com", origin), false);
  assert.equal(isTrustedAppNavigation("not a url", origin), false);
  assert.equal(isExternalHttpUrl("https://example.com"), true);
  assert.equal(isExternalHttpUrl("file:///tmp/secret"), false);
});

test("normalizes updater release notes and errors", () => {
  assert.equal(
    normalizeReleaseNotes([{ version: "1.1.0", note: "Fix one" }, { note: "Fix two" }]),
    "Fix one\n\nFix two",
  );
  assert.equal(normalizeReleaseNotes("  New release  "), "New release");
  assert.equal(updaterErrorMessage(new Error("Network unavailable")), "Network unavailable");
});

test("validates, writes, and reads desktop project snapshots", async () => {
  const directory = await makeTestDirectory("canvasly-project-");
  const filePath = path.join(directory, "project-state.json");
  try {
    await writeProjectSnapshot(filePath, validSnapshot);
    const source = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(source.projectName, "Landing page");
    assert.deepEqual(await readProjectSnapshot(filePath), validSnapshot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not commit a stale desktop project write", async () => {
  const directory = await makeTestDirectory("canvasly-project-");
  const filePath = path.join(directory, "project-state.json");
  try {
    await writeProjectSnapshot(filePath, validSnapshot);
    const committed = await writeProjectSnapshot(
      filePath,
      { ...validSnapshot, projectName: "Stale project" },
      { shouldCommit: () => false },
    );
    assert.equal(committed, false);
    assert.equal((await readProjectSnapshot(filePath)).projectName, "Landing page");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps synchronous collaboration save safe from an in-flight stale write", async () => {
  const directory = await makeTestDirectory("canvasly-collaboration-race-");
  const filePath = path.join(directory, "collaboration-state.json");
  const originalDateNow = Date.now;
  try {
    Date.now = () => 1234;
    const staleWrite = writeCollaborationState(
      filePath,
      {
        ...validCollaborationState,
        coworkMessages: [
          {
            id: "stale",
            role: "assistant",
            text: "Stale state",
          },
        ],
      },
      { shouldCommit: () => false },
    );
    writeCollaborationStateSync(filePath, {
      ...validCollaborationState,
      coworkMessages: [
        {
          id: "fresh",
          role: "assistant",
          text: "Unload state",
        },
      ],
    });

    assert.equal(await staleWrite, false);
    assert.equal(
      (await readCollaborationState(filePath)).unifiedMessages[0].id,
      "fresh",
    );
  } finally {
    Date.now = originalDateNow;
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers project and collaboration state from rollback files", async () => {
  const directory = await makeTestDirectory("canvasly-rollback-recovery-");
  const projectFile = path.join(directory, "project-state.json");
  const collaborationFile = path.join(
    directory,
    "collaboration-state.json",
  );
  try {
    await writeProjectSnapshot(
      `${projectFile}.rollback`,
      validSnapshot,
    );
    await writeCollaborationState(
      `${collaborationFile}.rollback`,
      validCollaborationState,
    );
    assert.deepEqual(
      await readProjectSnapshot(projectFile),
      validSnapshot,
    );
    assert.equal(
      (await readCollaborationState(collaborationFile))
        .unifiedMessages[0].id,
      "cowork-1",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists desktop endpoint preferences without API keys", async () => {
  const directory = await makeTestDirectory("canvasly-preferences-");
  const filePath = path.join(directory, "preferences.json");
  try {
    await writeDesktopPreferences(filePath, {
      ...validPreferences,
      modelConfig: {
        ...validPreferences.modelConfig,
        apiKey: "must-not-be-persisted",
      },
    });
    const source = await readFile(filePath, "utf8");
    assert.equal(source.includes("must-not-be-persisted"), false);
    assert.deepEqual(
      await readDesktopPreferences(filePath),
      validPreferences,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists collaboration history and restores work paused", async () => {
      const directory = await makeTestDirectory("canvasly-collaboration-");
      const filePath = path.join(directory, "collaboration-state.json");
      try {
        await writeCollaborationState(filePath, validCollaborationState);
        const restored = await readCollaborationState(filePath);
        assert.equal(restored.coworkMessages[0].citations[0].url, "https://example.com/design");
        assert.deepEqual(
          restored.unifiedMessages.map((message) => message.id),
          ["cowork-1", "chat-1"],
        );
        assert.equal(restored.coworkMessages[0].plan.strategy, "mission");
        assert.equal(restored.coworkMessages[0].plan.steps[0].id, "step-1");
        assert.equal(restored.handoffCards[0].title, "改进导航");
        assert.equal(restored.activeCoworkTask, null);
        assert.equal(restored.coworkQueuePaused, true);
        assert.deepEqual(
          restored.coworkQueue.map((task) => task.restoreState),
          ["interrupted", "paused"],
        );
        assert.deepEqual(restored.panes, validCollaborationState.panes);
        assert.deepEqual(restored.chatModelOverride, nonSecretModelConfig);
        assert.equal(restored.coworkStrategy, "mission");
        assert.equal(restored.coworkQueue[0].strategy, "mission");

        writeCollaborationStateSync(filePath, {
          ...restored,
          chatMessages: [
            ...restored.chatMessages,
            {
              id: "chat-2",
              role: "assistant",
              text: "重启后仍在",
              streamState: "streaming",
            },
          ],
        });
        const syncRestored = await readCollaborationState(filePath);
        assert.equal(syncRestored.chatMessages.at(-1).streamState, "stopped");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("migrates omitted schema-1 collaboration layout to parallel", () => {
      const state = normalizeCollaborationState({
        ...validCollaborationState,
        panes: {
          cowork: { open: true, width: 390 },
          chat: { open: true, width: 360 },
          activeMobilePane: "cowork",
        },
      });
      assert.equal(state.panes.layout, "parallel");
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            panes: {
              ...validCollaborationState.panes,
              layout: "stacked",
            },
          }),
        /协作布局无效/,
      );
    });

    test("stores and restores bounded collaboration attachment payloads", async () => {
      const directory = await makeTestDirectory("canvasly-attachment-payloads-");
      const attachmentDirectory = path.join(
        directory,
        "collaboration-attachments",
      );
      const store = createCollaborationAttachmentStore({
        directoryPath: attachmentDirectory,
      });
      try {
        const documentResult = await store.store({
          id: "document-1",
          name: "brief.md",
          mimeType: "text/markdown",
          kind: "document",
          text: "# Brief\nPersist this text.",
          sizeLabel: "27 B",
        });
        assert.equal(documentResult.ok, true);
        assert.match(
          documentResult.attachment.reference,
          /^canvasly-attachment:v1:[a-f0-9]{64}$/,
        );
        assert.equal(documentResult.attachment.sizeBytes, 26);

        const imageData =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
        const imageResult = await store.store({
          id: "image-1",
          name: "pixel.png",
          mimeType: "image/png",
          kind: "image",
          data: imageData,
        });
        assert.equal(imageResult.ok, true);

        const restartedStore = createCollaborationAttachmentStore({
          directoryPath: attachmentDirectory,
        });
        assert.deepEqual(
          await restartedStore.read(documentResult.attachment.reference),
          documentResult,
        );
        assert.deepEqual(
          await restartedStore.read(imageResult.attachment.reference),
          imageResult,
        );
        const files = await readdir(attachmentDirectory);
        assert.equal(files.some((file) => file.endsWith(".tmp")), false);
        if (process.platform !== "win32") {
          assert.equal((await stat(attachmentDirectory)).mode & 0o777, 0o700);
          for (const file of files) {
            assert.equal(
              (await stat(path.join(attachmentDirectory, file))).mode & 0o777,
              0o600,
            );
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("rejects unsafe attachment payloads and opaque reference traversal", async () => {
      const directory = await makeTestDirectory("canvasly-attachment-validation-");
      const attachmentDirectory = path.join(
        directory,
        "collaboration-attachments",
      );
      const store = createCollaborationAttachmentStore({
        directoryPath: attachmentDirectory,
      });
      try {
        assert.equal(
          (
            await store.store({
              id: "../../outside",
              name: "bad.txt",
              mimeType: "text/plain",
              kind: "document",
              text: "bad",
            })
          ).error.code,
          "invalid-attachment",
        );
        assert.equal(
          (
            await store.store({
              id: "too-large",
              name: "large.txt",
              mimeType: "text/plain",
              kind: "document",
              text: "x".repeat(120_001),
            })
          ).error.code,
          "attachment-too-large",
        );
        assert.equal(
          (
            await store.store({
              id: "secret-field",
              name: "secret.txt",
              mimeType: "text/plain",
              kind: "document",
              text: "ordinary content",
              apiKey: "must-not-be-written",
            })
          ).error.code,
          "invalid-attachment",
        );
        const traversal = await store.read(
          "canvasly-attachment:v1:../../project-state.json",
        );
        assert.equal(traversal.error.code, "invalid-attachment-reference");
        assert.equal(traversal.queueMustRemainPaused, true);
        await assert.rejects(readdir(attachmentDirectory), { code: "ENOENT" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("deletes attachments and reports missing or corrupt payloads safely", async () => {
      const directory = await makeTestDirectory("canvasly-attachment-errors-");
      const attachmentDirectory = path.join(
        directory,
        "collaboration-attachments",
      );
      const store = createCollaborationAttachmentStore({
        directoryPath: attachmentDirectory,
      });
      try {
        const deletedPayload = await store.store({
          id: "delete-me",
          name: "delete.txt",
          mimeType: "text/plain",
          kind: "document",
          text: "delete",
        });
        assert.equal(deletedPayload.ok, true);
        assert.deepEqual(
          await store.delete(deletedPayload.attachment.reference),
          {
            ok: true,
            reference: deletedPayload.attachment.reference,
            deleted: true,
          },
        );
        const missing = await store.read(deletedPayload.attachment.reference);
        assert.equal(missing.error.code, "attachment-not-found");
        assert.equal(missing.queueMustRemainPaused, true);

        const corruptPayload = await store.store({
          id: "corrupt-me",
          name: "corrupt.txt",
          mimeType: "text/plain",
          kind: "document",
          text: "corrupt",
        });
        const [payloadFile] = await readdir(attachmentDirectory);
        await writeFile(
          path.join(attachmentDirectory, payloadFile),
          "{\"schemaVersion\":1,\"apiKey\":\"must-not-load\"}",
          "utf8",
        );
        const corrupt = await store.read(corruptPayload.attachment.reference);
        assert.equal(corrupt.error.code, "attachment-corrupt");
        assert.equal(corrupt.queueMustRemainPaused, true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("rejects secrets and unsafe URLs in collaboration JSON", () => {
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            chatModelOverride: {
              ...nonSecretModelConfig,
              apiKey: "must-never-persist",
            },
          }),
        /不得包含 API 密钥字段/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            coworkMessages: [
              {
                id: "bad-citation",
                role: "assistant",
                text: "unsafe",
                citations: [
                  {
                    id: "citation",
                    title: "Local file",
                    url: "file:///Users/example/private.txt",
                  },
                ],
              },
            ],
          }),
        /HTTP\(S\)/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            coworkMessages: Array.from({ length: 201 }, (_, index) => ({
              id: `message-${index}`,
              role: "user",
              text: "bounded",
            })),
          }),
        /消息数量无效/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            chatModelOverride: {
              ...nonSecretModelConfig,
              baseUrl: "https://models.example.com/v1?access_token=secret",
            },
          }),
        /敏感查询参数/,
      );
      for (const key of ["key", "auth", "sig"]) {
        assert.throws(
          () =>
            normalizeCollaborationState({
              ...validCollaborationState,
              coworkMessages: [
                {
                  id: `sensitive-${key}`,
                  role: "assistant",
                  text: "unsafe signed URL",
                  citations: [
                    {
                      id: "citation",
                      title: "Signed source",
                      url: `https://example.com/source?${key}=secret`,
                    },
                  ],
                },
              ],
            }),
          /敏感查询参数/,
        );
      }
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            ignored: "x".repeat(8 * 1024 * 1024),
          }),
        /输入大小超过 8 MB/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            activeCoworkTask: {
              ...validCollaborationState.activeCoworkTask,
              attachments: [
                {
                  id: "http-reference",
                  name: "brief.txt",
                  mimeType: "text/plain",
                  kind: "document",
                  sizeBytes: 5,
                  reference: "https://example.com/brief.txt",
                },
              ],
            },
          }),
        /持久化引用/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            coworkStrategy: "unsafe",
          }),
        /Cowork 策略无效/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            coworkMessages: [
              {
                ...validCollaborationState.coworkMessages[0],
                plan: {
                  ...validCollaborationState.coworkMessages[0].plan,
                  apiKey: "must-not-persist",
                },
              },
            ],
          }),
        /不得包含 API 密钥字段/,
      );
      assert.throws(
        () =>
          normalizeCollaborationState({
            ...validCollaborationState,
            coworkMessages: [
              {
                ...validCollaborationState.coworkMessages[0],
                plan: {
                  ...validCollaborationState.coworkMessages[0].plan,
                  summary: "x".repeat(10_001),
                },
              },
            ],
          }),
        /任务计划摘要超过允许大小/,
      );
    });

    test("corrupt collaboration state does not prevent project restoration", async () => {
      const directory = await makeTestDirectory("canvasly-corrupt-collaboration-");
      const projectFile = path.join(directory, "project-state.json");
      const collaborationFile = path.join(directory, "collaboration-state.json");
      try {
        await writeProjectSnapshot(projectFile, validSnapshot);
        await writeFile(collaborationFile, "{corrupt", "utf8");
        await assert.rejects(readCollaborationState(collaborationFile), SyntaxError);
        assert.deepEqual(await readProjectSnapshot(projectFile), validSnapshot);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("quarantines unreadable collaboration state before starting fresh", async () => {
      const directory = await makeTestDirectory(
        "canvasly-quarantine-collaboration-",
      );
      const collaborationFile = path.join(
        directory,
        "collaboration-state.json",
      );
      try {
        await writeFile(collaborationFile, "{corrupt", "utf8");
        const backupFile = await quarantineCollaborationState(
          collaborationFile,
          1234,
        );
        assert.equal(
          backupFile,
          path.join(
            directory,
            "collaboration-state.corrupt-1234.json",
          ),
        );
        assert.equal(await readFile(backupFile, "utf8"), "{corrupt");
        await assert.rejects(readFile(collaborationFile, "utf8"), {
          code: "ENOENT",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("credential vault encrypts fixed slots and supports clearing", async () => {
      const directory = await makeTestDirectory("canvasly-credentials-");
      const filePath = path.join(directory, "credentials.enc.json");
      const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) =>
          Buffer.concat([
            Buffer.from("vault:"),
            Buffer.from(value, "utf8").reverse(),
          ]),
        decryptString: (value) => {
          if (!value.subarray(0, 6).equals(Buffer.from("vault:"))) {
            throw new Error("invalid ciphertext");
          }
          return value.subarray(6).reverse().toString("utf8");
        },
      };
      try {
        const first = createCredentialVault({ filePath, safeStorage });
        assert.deepEqual(
          await first.write("shared-model-api-key", "shared-test-secret"),
          { ok: true, slot: "shared-model-api-key", exists: true },
        );
        assert.equal(
          (await first.write("chat-model-api-key", "chat-test-secret")).ok,
          true,
        );
        const source = await readFile(filePath, "utf8");
        assert.doesNotMatch(source, /shared-test-secret|chat-test-secret/);

        await rename(filePath, `${filePath}.rollback`);
        const restarted = createCredentialVault({ filePath, safeStorage });
        const [restoredShared, restoredChat] = await Promise.all([
          restarted.read("shared-model-api-key"),
          restarted.read("chat-model-api-key"),
        ]);
        assert.equal(restoredShared.value, "shared-test-secret");
        assert.equal(restoredChat.value, "chat-test-secret");
        assert.equal((await restarted.clear("chat-model-api-key")).ok, true);
        assert.equal((await restarted.read("chat-model-api-key")).value, null);
        assert.equal((await restarted.status("chat-model-api-key")).exists, false);
        assert.equal((await restarted.read("arbitrary-slot")).error.code, "invalid-credential-slot");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("credential vault reports unavailable encryption and corrupt ciphertext", async () => {
      const directory = await makeTestDirectory("canvasly-credential-errors-");
      const filePath = path.join(directory, "credentials.enc.json");
      try {
        const unavailable = createCredentialVault({
          filePath,
          safeStorage: { isEncryptionAvailable: () => false },
        });
        assert.equal(
          (await unavailable.write("shared-model-api-key", "secret")).error.code,
          "encryption-unavailable",
        );
        const insecureLinuxFallback = createCredentialVault({
          filePath,
          safeStorage: {
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => "basic_text",
          },
        });
        assert.equal(
          (await insecureLinuxFallback.status("chat-model-api-key")).error.code,
          "encryption-unavailable",
        );
        await assert.rejects(readFile(filePath), { code: "ENOENT" });

        await writeFile(
          filePath,
          JSON.stringify({
            schemaVersion: 1,
            slots: { "shared-model-api-key": "not-valid-base64!" },
          }),
          "utf8",
        );
        const corrupt = createCredentialVault({
          filePath,
          safeStorage: {
            isEncryptionAvailable: () => true,
            decryptString: () => "",
          },
        });
        assert.equal(
          (await corrupt.status("shared-model-api-key")).error.code,
          "credential-file-corrupt",
        );

        await writeFile(
          filePath,
          JSON.stringify({
            schemaVersion: 1,
            slots: {
              "shared-model-api-key": Buffer.from("valid-shape").toString("base64"),
            },
          }),
          "utf8",
        );
        assert.equal(
          (await corrupt.read("shared-model-api-key")).error.code,
          "credential-decryption-failed",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
test("rejects malformed desktop project snapshots", () => {
  assert.throws(
    () => normalizeProjectSnapshot({ ...validSnapshot, historyIndex: 2 }),
    /当前版本索引无效/,
  );
  assert.throws(
    () => normalizeProjectSnapshot({ ...validSnapshot, schemaVersion: 2 }),
    /版本不受支持/,
  );
  assert.throws(
    () =>
      normalizeProjectSnapshot({
        ...validSnapshot,
        intentionalBlankFlags: [false, true],
      }),
    /空白版本标记无效/,
  );
  assert.throws(
    () =>
      normalizeDesktopPreferences({
        ...validPreferences,
        modelConfig: {
          ...validPreferences.modelConfig,
          protocol: "unsupported",
        },
      }),
    /请求协议不受支持/,
  );
  assert.throws(
    () =>
      normalizeDesktopPreferences({
        ...validPreferences,
        modelConfig: {
          ...validPreferences.modelConfig,
          baseUrl: "https://user:secret@models.example.com/v1",
        },
      }),
    /用户名或密码/,
  );
  assert.throws(
    () =>
      normalizeDesktopPreferences({
        ...validPreferences,
        modelConfig: {
          ...validPreferences.modelConfig,
          baseUrl: "https://models.example.com/v1?api_key=secret",
        },
      }),
    /敏感查询参数/,
  );
  for (const key of [
      "api_token",
      "auth_token",
      "access_key",
      "client_secret",
      "x-amz-signature",
      "x-amz-credential",
  ]) {
      assert.throws(
        () =>
          normalizeDesktopPreferences({
            ...validPreferences,
            modelConfig: {
              ...validPreferences.modelConfig,
              baseUrl: `https://models.example.com/v1?${key}=secret`,
            },
          }),
        /敏感查询参数/,
      );
  }
  assert.throws(
    () =>
      normalizeDesktopPreferences({
        ...validPreferences,
        modelConfig: {
          ...validPreferences.modelConfig,
          baseUrl: "https://models.example.com/v1?x-api-key=secret",
        },
      }),
    /敏感查询参数/,
  );
});
