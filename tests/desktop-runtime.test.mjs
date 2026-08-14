import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeProjectSnapshot,
  readProjectSnapshot,
  writeProjectSnapshot,
} from "../desktop/project-state.mjs";
import {
  isExternalHttpUrl,
  isTrustedAppNavigation,
  normalizeReleaseNotes,
  resolveDesktopServerDirectory,
  updaterErrorMessage,
} from "../desktop/runtime-utils.mjs";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvasly-project-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvasly-project-"));
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

test("rejects malformed desktop project snapshots", () => {
  assert.throws(
    () => normalizeProjectSnapshot({ ...validSnapshot, historyIndex: 2 }),
    /当前版本索引无效/,
  );
  assert.throws(
    () => normalizeProjectSnapshot({ ...validSnapshot, schemaVersion: 2 }),
    /版本不受支持/,
  );
});
