import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron as electron } from "playwright-core";
import { writeProjectSnapshot } from "../desktop/project-state.mjs";
import { writeCollaborationState } from "../desktop/collaboration-state.mjs";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testRuntimeRoot = path.join(projectRoot, ".sites-runtime", "tests");

async function makeTestDirectory(prefix) {
  await mkdir(testRuntimeRoot, { recursive: true });
  return mkdtemp(path.join(testRuntimeRoot, prefix));
}

async function allFileContents(directory) {
  const contents = [];
  for (const entry of await readdir(directory)) {
    const entryPath = path.join(directory, entry);
    const info = await stat(entryPath).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      contents.push(...await allFileContents(entryPath));
    } else if (info.isFile() && info.size <= 20 * 1024 * 1024) {
      contents.push(await readFile(entryPath));
    }
  }
  return contents;
}

async function launchDesktop(userDataDirectory) {
  const electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [projectRoot],
    env: {
      ...process.env,
      CANVASLY_DESKTOP_USER_DATA_DIR: userDataDirectory,
    },
    timeout: 120_000,
  });
  const page = await electronApp.firstWindow();
  await page.locator('iframe[title="HTML 页面预览"]').waitFor();
  return { electronApp, page };
}

async function click(page, locator) {
  await locator.evaluate((element) => element.click());
}

test("desktop restart restores endpoint and recovers visible history", {
  timeout: 240_000,
}, async () => {
  const userDataDirectory = await makeTestDirectory("canvasly-desktop-e2e-");
  const projectFile = path.join(userDataDirectory, "project-state.json");
  const preferencesFile = path.join(userDataDirectory, "preferences.json");
  const visibleHtml =
    "<!doctype html><html><body><main><h1>Recovered after restart</h1></main></body></html>";
  const blankHtml =
    "<!doctype html><html><head><style>body{background:#eee}</style></head><body></body></html>";
  const draftHtml =
    "<!doctype html><html><body><main><h1>Unsaved source draft survives</h1></main></body></html>";

  await writeProjectSnapshot(projectFile, {
    schemaVersion: 1,
    projectName: "Recovery test",
    history: [visibleHtml, blankHtml],
    historyIndex: 1,
    intentionalBlankFlags: [false, false],
    codeDraft: draftHtml,
    projectBaseline: visibleHtml,
    savedHtml: visibleHtml,
    savedAt: new Date().toISOString(),
  });

  try {
    const first = await launchDesktop(userDataDirectory);
    try {
      await first.page
        .frameLocator('iframe[title="HTML 页面预览"]')
        .getByRole("heading", { name: "Recovered after restart" })
        .waitFor();
      await click(
        first.page,
        first.page.locator(".tool-rail").getByRole("button", {
          name: "查看 HTML",
        }),
      );
      assert.match(
        await first.page
          .getByRole("textbox", { name: "HTML 源码" })
          .inputValue(),
        /Unsaved source draft survives/,
      );
      await click(
        first.page,
        first.page.getByRole("button", { name: "模型设置" }),
      );
      await click(
        first.page,
        first.page.getByRole("button", { name: /Custom endpoint/ }),
      );
      await first.page
        .getByRole("textbox", { name: /节点地址/ })
        .fill("http://127.0.0.1:4242/v1");
      await first.page
        .getByRole("textbox", { name: /模型名称/ })
        .fill("persistent-model");
      await first.page
        .getByLabel(/API 密钥/)
        .fill("desktop-secret-must-not-persist");
      await click(
        first.page,
        first.page.getByRole("button", { name: "保存连接" }),
      );
      await assert.doesNotReject(async () => {
        await first.page.waitForFunction(async () => {
          const result = await window.canvaslyDesktop?.loadPreferences();
          return (
            result?.modelConfig.baseUrl ===
            "http://127.0.0.1:4242/v1"
          );
        });
      });
    } finally {
      await first.electronApp.close();
    }

    const preferencesSource = await readFile(preferencesFile, "utf8");
    assert.match(preferencesSource, /127\.0\.0\.1:4242/);
    assert.match(preferencesSource, /persistent-model/);
    assert.doesNotMatch(
      preferencesSource,
      /desktop-secret-must-not-persist/,
    );
    for (const content of await allFileContents(userDataDirectory)) {
      assert.equal(
        content.includes(
          Buffer.from("desktop-secret-must-not-persist"),
        ),
        false,
      );
    }

    const second = await launchDesktop(userDataDirectory);
    try {
      await second.page
        .getByRole("button", { name: "模型设置" })
        .waitFor();
      await click(
        second.page,
        second.page.getByRole("button", { name: "模型设置" }),
      );
      await second.page
        .getByRole("dialog", { name: "连接你的模型" })
        .waitFor();
      assert.equal(
        await second.page
          .getByRole("textbox", { name: /^节点地址/ })
          .inputValue(),
        "http://127.0.0.1:4242/v1",
      );
      assert.equal(
        await second.page
          .getByRole("textbox", { name: /^模型名称/ })
          .inputValue(),
        "persistent-model",
      );
      assert.match(
        await second.page
          .locator(".connection-fields input[type=password]")
          .inputValue(),
        /^desktop-secret-must-not-persist/,
      );
      await second.page
        .frameLocator('iframe[title="HTML 页面预览"]')
        .getByRole("heading", { name: "Recovered after restart" })
        .waitFor();
    } finally {
      await second.electronApp.close();
    }
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("desktop restart preserves an intentional blank version", {
  timeout: 120_000,
}, async () => {
  const userDataDirectory = await makeTestDirectory("canvasly-intentional-blank-");
  const visibleHtml =
    "<!doctype html><html><body><h1>Older visible page</h1></body></html>";
  const blankHtml =
    "<!doctype html><html><head><style>body{background:#fff}</style></head><body></body></html>";
  const accidentalBlankHtml =
    "<!doctype html><html><head><style>body{background:#eee}</style></head><body></body></html>";
  await writeProjectSnapshot(
    path.join(userDataDirectory, "project-state.json"),
    {
      schemaVersion: 1,
      projectName: "Intentional blank",
      history: [visibleHtml, blankHtml, accidentalBlankHtml],
      historyIndex: 2,
      intentionalBlankFlags: [false, true, false],
      codeDraft: accidentalBlankHtml,
      projectBaseline: visibleHtml,
      savedHtml: blankHtml,
      savedAt: new Date().toISOString(),
    },
  );
  try {
    const desktop = await launchDesktop(userDataDirectory);
    try {
      await desktop.page.waitForFunction(() =>
        document.querySelector(".status-meta")?.textContent?.includes("2 / 3"),
      );
      assert.match(
        await desktop.page.locator(".status-meta").innerText(),
        /2\s*\/\s*3/,
      );
      assert.equal(
        await desktop.page
          .frameLocator('iframe[title="HTML 页面预览"]')
          .locator("body")
          .innerText(),
        "",
      );
    } finally {
      await desktop.electronApp.close();
    }
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("encrypted credentials and collaboration survive a real Electron restart", {
  timeout: 240_000,
}, async (t) => {
  const userDataDirectory = await makeTestDirectory("canvasly-secure-restart-");
  const sharedSecret = "real-shared-secret-93b83c";
  const chatSecret = "real-chat-secret-715a29";
  const credentialFile = path.join(userDataDirectory, "credentials.enc.json");
  try {
    const first = await launchDesktop(userDataDirectory);
    try {
      const status = await first.page.evaluate(
        () => window.canvaslyDesktop?.getCredentialStatus("shared-model-api-key"),
      );
      if (!status?.ok && status?.error.code === "encryption-unavailable") {
        t.skip("Electron safeStorage is unavailable on this host");
        return;
      }
      assert.equal(status?.ok, true);
      assert.deepEqual(
        await first.page.evaluate(
          (value) =>
            window.canvaslyDesktop?.writeCredential(
              "shared-model-api-key",
              value,
            ),
          sharedSecret,
        ),
        { ok: true, slot: "shared-model-api-key", exists: true },
      );
      assert.equal(
        (
          await first.page.evaluate(
            (value) =>
              window.canvaslyDesktop?.writeCredential(
                "chat-model-api-key",
                value,
              ),
            chatSecret,
          )
        )?.ok,
        true,
      );
      await first.page.evaluate(async () => {
        await window.canvaslyDesktop?.saveCollaboration({
          schemaVersion: 1,
          coworkMessages: [
            {
              id: "cowork-real-1",
              role: "assistant",
              text: "Restart-safe Cowork history",
              plan: {
                strategy: "mission",
                objective: "Verify mission restoration",
                summary: "Restore the saved mission before execution.",
                assumptions: ["The project remains available"],
                steps: [
                  {
                    id: "restart-step-1",
                    title: "Restore mission",
                    description: "Load the persisted mission plan.",
                  },
                ],
                acceptanceCriteria: ["Mission plan is visible after restart"],
                openQuestions: [],
              },
              streamState: "completed",
            },
          ],
          chatMessages: [
            {
              id: "chat-real-1",
              role: "user",
              text: "Restart-safe Chat history",
            },
          ],
          handoffCards: [
            {
              id: "handoff-real-1",
              title: "Restart-safe task card",
              objective: "Verify persistence",
              decisions: [],
              references: [],
              constraints: [],
              openQuestions: [],
              instruction: "Keep this card",
              sourceMessageIds: ["chat-real-1"],
              createdAt: "2026-08-14T00:00:00.000Z",
            },
          ],
          coworkQueue: [],
          coworkQueuePaused: false,
          coworkStrategy: "mission",
          activeCoworkTask: {
            id: "active-real-1",
            messageId: "cowork-real-1",
            mode: "cowork",
            instruction: "Paused after restart",
            attachments: [],
            selection: null,
            priority: "normal",
            strategy: "mission",
            modelConfig: {
              providerId: "demo",
              protocol: "demo",
              baseUrl: "",
              model: "demo",
            },
          },
          panes: {
            cowork: { open: true, width: 420 },
            chat: { open: false, width: 340 },
            activeMobilePane: "cowork",
            layout: "switch",
          },
          chatModelOverride: null,
          attachments: { cowork: [], chat: [] },
          savedAt: "2026-08-14T00:00:00.000Z",
        });
      });
    } finally {
      await first.electronApp.close();
    }

    const credentialSource = await readFile(credentialFile, "utf8");
    assert.doesNotMatch(credentialSource, new RegExp(`${sharedSecret}|${chatSecret}`));
    await writeCollaborationState(
      path.join(userDataDirectory, "collaboration-state.json"),
      {
        schemaVersion: 1,
        coworkMessages: [
          {
            id: "cowork-real-1",
            role: "assistant",
            text: "Restart-safe Cowork history",
            plan: {
              strategy: "mission",
              objective: "Verify mission restoration",
              summary: "Restore the saved mission before execution.",
              assumptions: ["The project remains available"],
              steps: [
                {
                  id: "restart-step-1",
                  title: "Restore mission",
                  description: "Load the persisted mission plan.",
                },
              ],
              acceptanceCriteria: ["Mission plan is visible after restart"],
              openQuestions: [],
            },
            streamState: "completed",
          },
        ],
        chatMessages: [
          {
            id: "chat-real-1",
            role: "user",
            text: "Restart-safe Chat history",
          },
        ],
        handoffCards: [
          {
            id: "handoff-real-1",
            title: "Restart-safe task card",
            objective: "Verify persistence",
            decisions: [],
            references: [],
            constraints: [],
            openQuestions: [],
            instruction: "Keep this card",
            sourceMessageIds: ["chat-real-1"],
            createdAt: "2026-08-14T00:00:00.000Z",
          },
        ],
        coworkQueue: [],
        coworkQueuePaused: false,
        coworkStrategy: "mission",
        activeCoworkTask: {
          id: "active-real-1",
          messageId: "cowork-real-1",
          mode: "cowork",
          instruction: "Paused after restart",
          attachments: [],
          selection: null,
          priority: "normal",
          strategy: "mission",
          modelConfig: {
            providerId: "demo",
            protocol: "demo",
            baseUrl: "",
            model: "demo",
          },
        },
        panes: {
          cowork: { open: true, width: 420 },
          chat: { open: false, width: 340 },
          activeMobilePane: "cowork",
          layout: "switch",
        },
        chatModelOverride: null,
        attachments: { cowork: [], chat: [] },
        savedAt: "2026-08-14T00:00:00.000Z",
      },
    );

    const second = await launchDesktop(userDataDirectory);
    try {
      const initialCollaboration = await second.page.evaluate(
        () => window.canvaslyDesktop?.loadCollaboration(),
      );
      assert.equal(initialCollaboration.activeMode, "auto");
      assert.equal(initialCollaboration.pane.open, true);
      assert.equal(initialCollaboration.pane.width, 420);
      assert.equal(
        initialCollaboration.unifiedMessages[0].plan.steps[0].id,
        "restart-step-1",
      );
      assert.equal(
        initialCollaboration.coworkQueue[0].interactionMode,
        "auto",
      );
      await second.page
        .locator(".cowork-pane")
        .getByText("Restart-safe Cowork history")
        .waitFor();
      await second.page
        .locator(".cowork-pane")
        .getByText(/队列已暂停 · 1 项待办/)
        .waitFor();
      await second.page
        .locator(".cowork-pane")
        .getByText("Restart-safe Chat history")
        .waitFor();
      assert.equal(
        (
          await second.page.evaluate(
            () =>
              window.canvaslyDesktop?.readCredential(
                "shared-model-api-key",
              ),
          )
        )?.value,
        sharedSecret,
      );
      assert.equal(
        (
          await second.page.evaluate(
            () =>
              window.canvaslyDesktop?.readCredential("chat-model-api-key"),
          )
        )?.value,
        chatSecret,
      );
      const collaboration = await second.page.evaluate(
        () => window.canvaslyDesktop?.loadCollaboration(),
      );
      assert.equal(
        collaboration.unifiedMessages[0].text,
        "Restart-safe Cowork history",
      );
      assert.equal(
        collaboration.unifiedMessages[1].text,
        "Restart-safe Chat history",
      );
      assert.equal(collaboration.handoffCards[0].title, "Restart-safe task card");
      assert.equal(collaboration.activeCoworkTask, null);
      assert.equal(collaboration.coworkQueuePaused, true);
      assert.equal(collaboration.coworkQueue[0].restoreState, "interrupted");
      assert.equal(
        (
          await second.page.evaluate(
            () =>
              window.canvaslyDesktop?.clearCredential(
                "shared-model-api-key",
              ),
          )
        )?.exists,
        false,
      );
      assert.equal(
        (
          await second.page.evaluate(
            () =>
              window.canvaslyDesktop?.readCredential(
                "shared-model-api-key",
              ),
          )
        )?.value,
        null,
      );
    } finally {
      await second.electronApp.close();
    }

    for (const content of await allFileContents(userDataDirectory)) {
      assert.equal(content.includes(Buffer.from(sharedSecret)), false);
      assert.equal(content.includes(Buffer.from(chatSecret)), false);
    }

    const credentialJson = JSON.parse(await readFile(credentialFile, "utf8"));
    credentialJson.slots["chat-model-api-key"] =
      Buffer.from("corrupt-ciphertext").toString("base64");
    await writeFile(credentialFile, `${JSON.stringify(credentialJson)}\n`, "utf8");
    const third = await launchDesktop(userDataDirectory);
    try {
      const corruptResult = await third.page.evaluate(
        () => window.canvaslyDesktop?.readCredential("chat-model-api-key"),
      );
      assert.equal(corruptResult?.ok, false);
      assert.equal(
        corruptResult?.error.code,
        "credential-decryption-failed",
      );
      assert.equal(
        (await third.page.evaluate(
          () => window.canvaslyDesktop?.loadCollaboration(),
        )).unifiedMessages[0].id,
        "cowork-real-1",
      );
    } finally {
      await third.electronApp.close();
    }
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("queued and pending attachment payloads survive Electron restart", {
  timeout: 180_000,
}, async () => {
  const userDataDirectory = await makeTestDirectory(
    "canvasly-attachment-restart-",
  );
  const documentText = "Attachment payload restored after restart.";
  const imageData =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const rejectedApiKey = "attachment-api-key-must-not-persist";
  let storedAttachments;
  try {
    const first = await launchDesktop(userDataDirectory);
    try {
      const setup = await first.page.evaluate(
        async ({ documentText, imageData, rejectedApiKey }) => {
          const desktop = window.canvaslyDesktop;
          const documentResult =
            await desktop?.storeCollaborationAttachment({
              id: "restart-document",
              name: "restart.md",
              mimeType: "text/markdown",
              kind: "document",
              text: documentText,
            });
          const imageResult =
            await desktop?.storeCollaborationAttachment({
              id: "restart-image",
              name: "restart.png",
              mimeType: "image/png",
              kind: "image",
              data: imageData,
            });
          const traversal = await desktop?.readCollaborationAttachment(
            "canvasly-attachment:v1:../../preferences.json",
          );
          const oversized = await desktop?.storeCollaborationAttachment({
            id: "oversized-document",
            name: "oversized.txt",
            mimeType: "text/plain",
            kind: "document",
            text: "x".repeat(120_001),
          });
          const secretField =
            await desktop?.storeCollaborationAttachment({
              id: "secret-document",
              name: "secret.txt",
              mimeType: "text/plain",
              kind: "document",
              text: "safe content",
              apiKey: rejectedApiKey,
            });
          if (!documentResult?.ok || !imageResult?.ok) {
            throw new Error("Failed to store Electron attachment fixtures");
          }
          const metadata = (attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            kind: attachment.kind,
            sizeBytes: attachment.sizeBytes,
            ...(attachment.sizeLabel
              ? { sizeLabel: attachment.sizeLabel }
              : {}),
            reference: attachment.reference,
          });
          return {
            document: metadata(documentResult.attachment),
            image: metadata(imageResult.attachment),
            traversalCode: traversal?.ok ? null : traversal?.error.code,
            oversizedCode: oversized?.ok ? null : oversized?.error.code,
            secretFieldCode: secretField?.ok
              ? null
              : secretField?.error.code,
          };
        },
        { documentText, imageData, rejectedApiKey },
      );
      assert.equal(setup.traversalCode, "invalid-attachment-reference");
      assert.equal(setup.oversizedCode, "attachment-too-large");
      assert.equal(setup.secretFieldCode, "invalid-attachment");
      storedAttachments = {
        document: setup.document,
        image: setup.image,
      };
    } finally {
      await first.electronApp.close();
    }

    assert.ok(storedAttachments);
    await writeCollaborationState(
      path.join(userDataDirectory, "collaboration-state.json"),
      {
        schemaVersion: 1,
        coworkMessages: [],
        chatMessages: [],
        handoffCards: [],
        coworkQueue: [],
        coworkQueuePaused: false,
        activeCoworkTask: {
          id: "attachment-task",
          messageId: "attachment-message",
          mode: "cowork",
          instruction: "Use the restored image",
          attachments: [storedAttachments.image],
          selection: null,
          priority: "normal",
          modelConfig: {
            providerId: "demo",
            protocol: "demo",
            baseUrl: "",
            model: "demo",
          },
        },
        panes: {
          cowork: { open: true, width: 390 },
          chat: { open: true, width: 360 },
          activeMobilePane: "cowork",
          layout: "switch",
        },
        chatModelOverride: null,
        attachments: {
          cowork: [],
          chat: [storedAttachments.document],
        },
        savedAt: "2026-08-14T00:00:00.000Z",
      },
    );

    const collaborationSource = await readFile(
      path.join(userDataDirectory, "collaboration-state.json"),
      "utf8",
    );
    assert.doesNotMatch(collaborationSource, /data:image|Attachment payload/);

    const second = await launchDesktop(userDataDirectory);
    try {
      const restored = await second.page.evaluate(async () => {
        const desktop = window.canvaslyDesktop;
        const state = await desktop?.loadCollaboration();
        const queuedReference =
          state?.coworkQueue[0]?.attachments[0]?.reference;
        const pendingReference = state?.attachments.chat[0]?.reference;
        return {
          state,
          queued: queuedReference
            ? await desktop?.readCollaborationAttachment(queuedReference)
            : null,
          pending: pendingReference
            ? await desktop?.readCollaborationAttachment(pendingReference)
            : null,
        };
      });
      assert.equal(restored.state.coworkQueuePaused, true);
      assert.equal(restored.state.coworkQueue[0].restoreState, "interrupted");
      assert.equal(restored.state.panes.layout, "switch");
      assert.equal(restored.queued.attachment.data, imageData);
      assert.equal(restored.pending.attachment.text, documentText);

      const deleted = await second.page.evaluate(async () => {
        const desktop = window.canvaslyDesktop;
        const state = await desktop?.loadCollaboration();
        const reference = state?.attachments.chat[0]?.reference;
        if (!reference) throw new Error("Missing pending attachment reference");
        const deletion =
          await desktop?.deleteCollaborationAttachment(reference);
        const missing =
          await desktop?.readCollaborationAttachment(reference);
        return { deletion, missing };
      });
      assert.equal(deleted.deletion.deleted, true);
      assert.equal(deleted.missing.error.code, "attachment-not-found");
      assert.equal(deleted.missing.queueMustRemainPaused, true);
    } finally {
      await second.electronApp.close();
    }

    for (const content of await allFileContents(userDataDirectory)) {
      assert.equal(content.includes(Buffer.from(rejectedApiKey)), false);
    }
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
