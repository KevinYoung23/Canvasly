import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron as electron } from "playwright-core";
import { writeProjectSnapshot } from "../desktop/project-state.mjs";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "canvasly-desktop-e2e-"),
  );
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

    const second = await launchDesktop(userDataDirectory);
    try {
      await click(
        second.page,
        second.page.getByRole("button", { name: "模型设置" }),
      );
      assert.equal(
        await second.page
          .getByRole("textbox", { name: /节点地址/ })
          .inputValue(),
        "http://127.0.0.1:4242/v1",
      );
      assert.equal(
        await second.page
          .getByRole("textbox", { name: /模型名称/ })
          .inputValue(),
        "persistent-model",
      );
      assert.equal(
        await second.page.getByLabel(/API 密钥/).inputValue(),
        "",
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
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "canvasly-intentional-blank-"),
  );
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
