import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const canvaslyUrl = process.env.CANVASLY_E2E_URL || "http://127.0.0.1:4173";
const gatewayPort = Number(process.env.CANVASLY_MOCK_PORT || 4143);
const gatewayHost =
  process.env.CANVASLY_GATEWAY_HOST || "host.docker.internal";
const gatewayUrl = `http://${gatewayHost}:${gatewayPort}/v1`;
const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));

let browser;
let gateway;
const gatewayRequests = [];

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item?.text || "").join("\n");
}

function parseGatewayRequest(payload) {
  const messages = Array.isArray(payload.input) ? payload.input : [];
  const system = messages
    .filter((item) => item?.role === "system")
    .map((item) => contentText(item.content))
    .join("\n");
  const user = messages
    .filter((item) => item?.role === "user")
    .map((item) => contentText(item.content))
    .join("\n");
  const instruction = user.match(/USER INSTRUCTION\n([\s\S]*?)\n\nSELECTED CONTEXT/)?.[1]?.trim() || "";
  const html = user.match(/<canvasly_html>\n([\s\S]*?)\n<\/canvasly_html>/)?.[1] || "";
  return { system, user, instruction, html };
}

function isExecutionGatewayRequest(request) {
  return (
    !/unified coding-agent conversation/i.test(request.system) &&
    !/mission planner/i.test(request.system)
  );
}

function injectBeforeBodyEnd(html, markup) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${markup}</body>`) : `${html}${markup}`;
}

function gatewayResult(request) {
  const { system, instruction } = request;
  if (/unified coding-agent conversation/i.test(system)) {
    const action = /E2E (?:AUTO )?CHAT|what|why|how|建议|讨论|聊聊/i.test(
      instruction,
    )
      ? "chat"
      : /E2E AUTO PLAN|只规划|先规划/i.test(instruction)
        ? "plan"
        : "agent";
    return {
      action,
      summary:
        action === "chat"
          ? "Answer in the conversation without editing."
          : action === "plan"
            ? "Create a plan without editing."
            : "Execute the requested page change.",
    };
  }
  if (/mission planner/i.test(system)) {
    return {
      strategy: "mission",
      objective: "Improve the whole page for clarity and conversion.",
      summary: "Audit hierarchy, strengthen the primary action, and align the visual system.",
      assumptions: ["Preserve the existing brand and unrelated content."],
      steps: [
        {
          id: "step-1",
          title: "Clarify hierarchy",
          description: "Strengthen the headline and content grouping.",
        },
        {
          id: "step-2",
          title: "Improve conversion",
          description: "Make the primary action easier to understand.",
        },
      ],
      acceptanceCriteria: [
        "The page has a clear primary message.",
        "The primary action is visually prominent.",
      ],
      openQuestions: [],
    };
  }
  if (/handoff card/i.test(system)) {
    return {
      title: "Approved launch direction",
      objective: "Turn the Chat discussion into an executable page update.",
      decisions: ["Keep the current hero", "Add one execution marker"],
      references: [
        {
          title: "Canvasly source",
          url: "https://example.com/canvasly",
          note: "Reference from the Chat discussion.",
        },
      ],
      constraints: ["Do not remove unrelated content"],
      openQuestions: [],
      instruction: "E2E COMPLETE",
    };
  }
  if (/Canvasly Chat/.test(system)) {
    return { reply: `Mock advisory reply for ${instruction}` };
  }
  if (/E2E BLOCKED/.test(instruction)) {
    return {
      status: "blocked",
      summary: "缺少可执行目标",
      updates: [],
      issues: ["当前要求没有提供目标页面或区块。"],
      suggestions: [
        { label: "改为页内导航", description: "创建真实锚点。", prompt: "请改为页内锚点导航" },
        { label: "提供目标地址", description: "补充 HTTPS URL。", prompt: "请使用这个 HTTPS 地址：" },
      ],
    };
  }
  if (/E2E BLANK/.test(instruction)) {
    return {
      status: "completed",
      html: "<!doctype html><html><head><style>body{background:#eee}</style></head><body></body></html>",
      summary: "Returned an invalid blank page",
      updates: ["Removed all visible content unexpectedly"],
      issues: [],
      suggestions: [],
    };
  }

  let html = request.html;
  let status = "completed";
  let updates = [`Applied ${instruction}`];
  let issues = [];
  let suggestions = [];

  if (/E2E TARGET/.test(instruction)) {
    html = html.replace(/(<h2[^>]*>)\s*Beta\s*(<\/h2>)/i, "$1Targeted Beta$2");
    updates = ["只更新了选中的 Beta 卡片"];
  } else if (/E2E REGION INSERT/.test(instruction)) {
    html = html.replace(
      /(<div\b[^>]*data-canvasly-insertion-slot=["'][^"']+["'][^>]*>)(\s*)(<\/div>)/i,
      '$1<article id="e2e-region-card"><h2>Region card</h2></article>$3',
    );
    updates = ["在圈选插槽中添加 Region card"];
  } else {
    const step = instruction.match(/E2E (FIRST|STEER|QUEUE|COMPLETE|PARTIAL)/)?.[1];
    if (step) {
      html = injectBeforeBodyEnd(html, `<div data-e2e-step="${step.toLowerCase()}">${step}</div>`);
      updates = [`Added ${step} marker`];
    }
    if (step === "PARTIAL") {
      status = "partial";
      issues = ["第二个目标缺少 URL。"];
      suggestions = [{ label: "补充 URL", description: "提供第二个目标。", prompt: "第二个目标 URL 是：" }];
    }
  }

  return {
    status,
    html,
    summary: status === "partial" ? "已完成可执行部分" : "确定性更新已完成",
    updates,
    issues,
    suggestions,
  };
}

async function startGateway() {
  gateway = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || "{}");
    const parsed = parseGatewayRequest(payload);
    gatewayRequests.push({ ...parsed, receivedAt: Date.now() });
    const streamResponses = async ({
      chunks,
      delay = 80,
      citation,
    }) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const chunk of chunks) {
        if (response.destroyed || response.writableEnded) return;
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: chunk,
          })}\n\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (citation && !response.destroyed && !response.writableEnded) {
        response.write(
          `event: response.output_text.annotation.added\ndata: ${JSON.stringify({
            type: "response.output_text.annotation.added",
            annotation: {
              type: "url_citation",
              url: citation.url,
              title: citation.title,
              content: citation.snippet,
            },
          })}\n\n`,
        );
      }
      if (!response.destroyed && !response.writableEnded) {
        response.end(
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        );
      }
    };
    if (
      /E2E CHAT STREAM/.test(parsed.instruction) &&
      /Canvasly Chat/i.test(parsed.system)
    ) {
      await streamResponses({
        chunks: ["Partial streamed answer. ", "This should not arrive after stop."],
        delay: 500,
      });
      return;
    }
    if (
      /E2E CHAT SEARCH/.test(parsed.instruction) &&
      /Canvasly Chat/i.test(parsed.system)
    ) {
      await streamResponses({
        chunks: ["Search-backed answer with a source."],
        citation: {
          title: "Example research",
          url: "https://example.com/research",
          snippet: "Verified reference",
        },
      });
      return;
    }
    if (/E2E SLOW COWORK/.test(parsed.instruction)) {
      const result = JSON.stringify({
        status: "completed",
        html: injectBeforeBodyEnd(
          parsed.html,
          '<div data-e2e-step="slow">SLOW</div>',
        ),
        summary: "Slow update completed",
        updates: ["Added slow marker"],
        issues: [],
        suggestions: [],
      });
      await streamResponses({
        chunks: [result.slice(0, 80), result.slice(80)],
        delay: 650,
      });
      return;
    }
    if (
      /E2E SLOW MISSION/.test(parsed.instruction) &&
      /mission planner/i.test(parsed.system)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    } else if (/E2E FIRST/.test(parsed.instruction)) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "response",
      output_text: JSON.stringify(gatewayResult(parsed)),
    }));
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(gatewayPort, "0.0.0.0", resolve);
  });
}

async function newPage(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(canvaslyUrl, { waitUntil: "domcontentloaded" });
  await page.locator('iframe[title="HTML 页面预览"]').waitFor();
  return { context, page };
}

async function newDesktopPage(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    const calls = [];
    const listeners = new Set();
    let updateState = {
      status: "idle",
      currentVersion: "0.1.0",
      message: "可以检查 GitHub Releases 中的新版本",
    };
    const publish = (state) => {
      updateState = state;
      for (const listener of listeners) listener(state);
    };
    Object.defineProperty(window, "__canvaslyDesktopCalls", {
      value: calls,
      configurable: false,
    });
    Object.defineProperty(window, "canvaslyDesktop", {
      value: {
        getInfo: async () => ({
          version: "0.1.0",
          platform: "darwin",
          packaged: true,
        }),
        loadProject: async () => ({
          schemaVersion: 1,
          projectName: "Recovered desktop project",
          history: [
            "<!doctype html><html><body><main><h1>Saved visible page</h1></main></body></html>",
            "<!doctype html><html><head><style>body{background:#eee}</style></head><body></body></html>",
          ],
          historyIndex: 1,
          codeDraft:
            "<!doctype html><html><head><style>body{background:#eee}</style></head><body></body></html>",
          projectBaseline:
            "<!doctype html><html><body><main><h1>Saved visible page</h1></main></body></html>",
          savedHtml:
            "<!doctype html><html><body><main><h1>Saved visible page</h1></main></body></html>",
          savedAt: "2026-08-14T00:00:00.000Z",
        }),
        saveProject: async (snapshot) => {
          calls.push({ method: "saveProject", snapshot });
          return { savedAt: "2026-08-14T00:00:00.000Z" };
        },
        saveProjectBeforeUnload: (snapshot) => {
          calls.push({ method: "saveProjectBeforeUnload", snapshot });
          return { ok: true };
        },
        loadCollaboration: async () => null,
        saveCollaboration: async (state) => {
          calls.push({ method: "saveCollaboration", state });
          return { savedAt: "2026-08-14T00:00:00.000Z" };
        },
        saveCollaborationBeforeUnload: (state) => {
          calls.push({
            method: "saveCollaborationBeforeUnload",
            state,
          });
          return { ok: true };
        },
        getCredentialStatus: async (slot) => ({
          ok: true,
          slot,
          available: true,
          exists: false,
        }),
        readCredential: async (slot) => ({
          ok: true,
          slot,
          value: null,
        }),
        writeCredential: async (slot, value) => {
          calls.push({ method: "writeCredential", slot, value });
          return { ok: true, slot, exists: true };
        },
        clearCredential: async (slot) => {
          calls.push({ method: "clearCredential", slot });
          return { ok: true, slot, exists: false };
        },
        storeCollaborationAttachment: async (attachment) => {
          calls.push({
            method: "storeCollaborationAttachment",
            attachment,
          });
          return {
            ok: true,
            attachment: {
              ...attachment,
              sizeBytes:
                attachment.kind === "document"
                  ? new TextEncoder().encode(attachment.text).byteLength
                  : attachment.sizeBytes,
              reference:
                "canvasly-attachment:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          };
        },
        readCollaborationAttachment: async (reference) => ({
          ok: false,
          error: {
            code: "attachment-not-found",
            message: `Missing ${reference}`,
          },
          queueMustRemainPaused: true,
        }),
        deleteCollaborationAttachment: async (reference) => ({
          ok: true,
          reference,
          deleted: true,
        }),
        loadPreferences: async () => ({
          schemaVersion: 1,
          modelConfig: {
            providerId: "custom",
            protocol: "openai-responses",
            baseUrl: "https://saved.example.com/v1",
            model: "saved-model",
          },
          savedAt: "2026-08-14T00:00:00.000Z",
        }),
        savePreferences: async (preferences) => {
          calls.push({ method: "savePreferences", preferences });
          return { savedAt: "2026-08-14T00:00:00.000Z" };
        },
        savePreferencesBeforeUnload: (preferences) => {
          calls.push({
            method: "savePreferencesBeforeUnload",
            preferences,
          });
          return { ok: true };
        },
        getUpdateState: async () => updateState,
        checkForUpdates: async () => {
          calls.push({ method: "checkForUpdates" });
          publish({
            status: "available",
            currentVersion: "0.1.0",
            version: "0.2.0",
            releaseNotes: "Desktop updater E2E release",
            message: "发现 Canvasly 0.2.0",
          });
          return updateState;
        },
        downloadUpdate: async () => {
          calls.push({ method: "downloadUpdate" });
          publish({
            status: "downloading",
            currentVersion: "0.1.0",
            version: "0.2.0",
            percent: 50,
            transferred: 50,
            total: 100,
            bytesPerSecond: 25,
            message: "正在下载 50%",
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          publish({
            status: "downloaded",
            currentVersion: "0.1.0",
            version: "0.2.0",
            releaseNotes: "Desktop updater E2E release",
            message: "更新已下载，可以重启安装",
          });
          return updateState;
        },
        installUpdate: async () => {
          calls.push({ method: "installUpdate" });
          return { installing: true };
        },
        onUpdateState: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      configurable: false,
    });
  });
  const page = await context.newPage();
  await page.goto(canvaslyUrl, { waitUntil: "domcontentloaded" });
  await page.locator('iframe[title="HTML 页面预览"]').waitFor();
  return { context, page };
}

async function clickParent(page, locator) {
  await locator.evaluate((element) => element.click());
}

function coworkPane(page) {
  return page.locator(".cowork-pane");
}

async function configureMock(page) {
  await clickParent(page, page.getByRole("button", { name: "模型设置" }));
  await clickParent(page, page.getByRole("button", { name: /Custom endpoint/ }));
  await page.getByRole("textbox", { name: /节点地址/ }).fill(gatewayUrl);
  await page.getByRole("textbox", { name: /模型名称/ }).fill("canvasly-e2e-mock");
  await clickParent(page, page.getByRole("button", { name: "保存连接" }));
  await page.getByText("已连接 Custom endpoint").waitFor();
}

async function submit(page, instruction, timeout = 30_000) {
  const pane = coworkPane(page);
  const composer = pane.locator(".composer textarea");
  await composer.fill(instruction);
  await clickParent(
    page,
    pane.getByRole("button", { name: "发送" }),
  );
  await pane.locator(".message.working").waitFor({ state: "visible", timeout });
  await pane.locator(".message.working").waitFor({ state: "hidden", timeout });
}

function preview(page) {
  return page.frameLocator('iframe[title="HTML 页面预览"]');
}

function versionText(page) {
  return page.locator(".status-meta").innerText();
}

async function uploadHtml(page, name, html) {
  const input = page.locator('input[accept^=".html"]');
  await input.setInputFiles({ name, mimeType: "text/html", buffer: Buffer.from(html) });
  const replacement = page.getByRole("button", { name: "放弃并继续" });
  if (await replacement.isVisible().catch(() => false)) await clickParent(page, replacement);
  const projectName = name.replace(/\.(?:html?|xhtml)$/i, "");
  await page.getByRole("button", { name: projectName }).waitFor();
}

test.before(async () => {
  assert.ok(executablePath, "No supported Edge/Chrome/Chromium executable was found");
  const health = await fetch(canvaslyUrl);
  assert.equal(health.ok, true, `Canvasly is not reachable at ${canvaslyUrl}`);
  await startGateway();
  browser = await chromium.launch({ headless: true, executablePath });
});

test.after(async () => {
  await browser?.close();
  if (gateway?.listening) await new Promise((resolve) => gateway.close(resolve));
});

test("desktop updater, persistence bridge, and local endpoint defaults", async () => {
  const { context, page } = await newDesktopPage();
  try {
    await preview(page).getByRole("heading", {
      name: "Saved visible page",
    }).waitFor();
    await page
      .getByRole("button", { name: "桌面更新：检查更新" })
      .waitFor();
    await clickParent(page, page.getByRole("button", { name: "模型设置" }));
    await page.getByText("Canvasly 桌面版").waitFor();
    await page.getByText("当前版本 v0.1.0").waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: /节点地址/ }).inputValue(),
      "https://saved.example.com/v1",
    );
    assert.equal(
      await page.getByRole("textbox", { name: /模型名称/ }).inputValue(),
      "saved-model",
    );

    await clickParent(page, page.getByRole("button", { name: /Local model/ }));
    await assert.doesNotReject(async () => {
      await page
        .getByRole("textbox", { name: /节点地址/ })
        .waitFor();
    });
    assert.equal(
      await page.getByRole("textbox", { name: /节点地址/ }).inputValue(),
      "http://127.0.0.1:11434/v1",
    );
    await clickParent(
      page,
      page.getByRole("button", { name: "保存连接" }),
    );
    await page.waitForFunction(() =>
      window.__canvaslyDesktopCalls.some(
        (call) => call.method === "savePreferences",
      ));
    await clickParent(page, page.getByRole("button", { name: "模型设置" }));

    await clickParent(
      page,
      page.getByRole("button", { name: "检查更新", exact: true }),
    );
    await page
      .getByRole("button", { name: "下载 v0.2.0", exact: true })
      .waitFor();
    await clickParent(
      page,
      page.getByRole("button", { name: "下载 v0.2.0", exact: true }),
    );
    await page
      .getByRole("button", { name: "重启并安装", exact: true })
      .waitFor();
    await clickParent(
      page,
      page.getByRole("button", { name: "重启并安装", exact: true }),
    );

    await page.waitForFunction(() =>
      window.__canvaslyDesktopCalls.some(
        (call) => call.method === "installUpdate",
      ));
    const calls = await page.evaluate(() => window.__canvaslyDesktopCalls);
    assert.ok(calls.some((call) => call.method === "checkForUpdates"));
    assert.ok(calls.some((call) => call.method === "downloadUpdate"));
    assert.ok(calls.some((call) => call.method === "installUpdate"));
    const saved = calls.find((call) => call.method === "saveProject");
    assert.ok(saved, "desktop update should save the project before install");
    assert.equal("apiKey" in saved.snapshot, false);
    assert.equal(saved.snapshot.history.length > 0, true);
    const savedPreferences = calls.find(
      (call) =>
        call.method === "savePreferences" &&
        call.preferences.modelConfig.baseUrl ===
          "http://127.0.0.1:11434/v1",
    );
    assert.ok(savedPreferences, "desktop endpoint preferences should be saved");
    assert.equal(
      savedPreferences.preferences.modelConfig.baseUrl,
      "http://127.0.0.1:11434/v1",
    );
    assert.equal(
      "apiKey" in savedPreferences.preferences.modelConfig,
      false,
    );
  } finally {
    await context.close();
  }
});

test("desktop truncates large documents before persisting their byte size", async () => {
  const { context, page } = await newDesktopPage();
  try {
    const source = "资料".repeat(80_000);
    await page
      .locator('input[accept*=".txt"]')
      .setInputFiles({
        name: "large-reference.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(source),
      });
    await page.waitForFunction(() =>
      window.__canvaslyDesktopCalls.some(
        (call) => call.method === "storeCollaborationAttachment",
      ),
    );
    const call = await page.evaluate(() =>
      window.__canvaslyDesktopCalls.find(
        (item) => item.method === "storeCollaborationAttachment",
      ),
    );
    assert.equal(call.attachment.text.length, 120_000);
    assert.equal(
      call.attachment.sizeBytes,
      Buffer.byteLength(call.attachment.text, "utf8"),
    );
    assert.ok(
      call.attachment.sizeBytes <
        Buffer.byteLength(source, "utf8"),
    );
  } finally {
    await context.close();
  }
});

test("one Agent conversation can plan, discuss, and execute", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const agent = coworkPane(page);
    const beforeBox = await agent.boundingBox();
    assert.ok(beforeBox);
    const resizer = page.locator(".dock-edge-resizer");
    const resizerBox = await resizer.boundingBox();
    assert.ok(resizerBox);
    await page.mouse.move(
      resizerBox.x + resizerBox.width / 2,
      resizerBox.y + 100,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizerBox.x - 55,
      resizerBox.y + 100,
      { steps: 4 },
    );
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.ok((await agent.boundingBox()).width > beforeBox.width);

    const beforeVersion = await versionText(page);
    await agent
      .locator(".composer textarea")
      .fill("E2E AUTO CHAT：这个页面目前有什么问题？");
    await clickParent(
      page,
      agent.getByRole("button", { name: "发送" }),
    );
    await agent
      .getByText(/Mock advisory reply for E2E AUTO CHAT/)
      .waitFor();
    assert.equal(await versionText(page), beforeVersion);

    await clickParent(
      page,
      agent
        .getByRole("group", { name: "协作模式" })
        .getByRole("button", { name: "Agent" }),
    );
    await agent.locator(".composer textarea").fill("E2E COMPLETE");
    await clickParent(
      page,
      agent.getByRole("button", { name: "发送" }),
    );
    await preview(page)
      .locator('[data-e2e-step="complete"]')
      .waitFor();
    assert.ok(await agent.locator(".message.user").count() >= 2);
  } finally {
    await context.close();
  }
});

test("stopping Agent preserves partial text or checkpoint and pauses queue", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const agent = coworkPane(page);
    const beforeVersion = await versionText(page);
    await clickParent(
      page,
      agent
        .getByRole("group", { name: "协作模式" })
        .getByRole("button", { name: "Agent" }),
    );
    await agent
      .locator(".composer textarea")
      .fill("E2E SLOW COWORK");
    await clickParent(
      page,
      agent.getByRole("button", { name: "发送" }),
    );
    await agent.locator(".message.working").waitFor();
    await agent.locator(".composer textarea").fill("E2E COMPLETE");
    await clickParent(
      page,
      agent.getByRole("button", { name: "加入队列" }),
    );
    await clickParent(
      page,
      agent.getByRole("button", { name: "停止当前任务" }).last(),
    );
    await agent.getByText("任务已停止").waitFor();
    await agent
      .getByText(/队列已暂停 · 1 项待办/)
      .waitFor();
    assert.equal(await versionText(page), beforeVersion);
    assert.equal(
      await preview(page).locator('[data-e2e-step="slow"]').count(),
      0,
    );

    await clickParent(
      page,
      agent.getByRole("button", { name: "继续" }),
    );
    await preview(page)
      .locator('[data-e2e-step="complete"]')
      .waitFor();

    await clickParent(
      page,
      agent
        .getByRole("group", { name: "协作模式" })
        .getByRole("button", { name: "Auto" }),
    );
    await agent
      .locator(".composer textarea")
      .fill("E2E CHAT STREAM");
    await clickParent(
      page,
      agent.getByRole("button", { name: "发送" }),
    );
    await agent.getByText(/Partial streamed answer/).waitFor();
    await clickParent(
      page,
      agent.getByRole("button", { name: "停止当前任务" }).last(),
    );
    await agent.getByText(/已停止 · 保留已生成内容/).waitFor();
    await page.waitForTimeout(700);
    assert.equal(
      await agent.getByText(/This should not arrive/).count(),
      0,
    );
  } finally {
    await context.close();
  }
});

test("Auto research and Agent execution share one conversation", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const agent = coworkPane(page);
    await agent.locator(".composer textarea").fill("E2E CHAT SEARCH");
    await clickParent(
      page,
      agent.getByRole("button", { name: "发送" }),
    );
    await agent
      .getByRole("link", { name: /Example research/ })
      .waitFor();
    await clickParent(
      page,
      agent
        .getByRole("group", { name: "协作模式" })
        .getByRole("button", { name: "Agent" }),
    );
    await agent.locator(".composer textarea").fill("E2E COMPLETE");
    await clickParent(
      page,
      agent.getByRole("button", { name: "发送" }),
    );
    await preview(page)
      .locator('[data-e2e-step="complete"]')
      .waitFor();
    assert.ok(await agent.locator(".message.user").count() >= 2);
  } finally {
    await context.close();
  }
});

test("unified collaboration sidebar can collapse, reopen, and resize", async () => {
  const { context, page } = await newPage();
  try {
    const agent = coworkPane(page);
    const before = await agent.boundingBox();
    assert.ok(before);
    const resizer = page.locator(".dock-edge-resizer");
    const box = await resizer.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 2, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x - 50, box.y + 120, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.ok((await agent.boundingBox()).width > before.width);
    await clickParent(
      page,
      agent.getByRole("button", { name: "折叠协作侧栏" }),
    );
    await agent.waitFor({ state: "hidden" });
    await clickParent(
      page,
      page.getByRole("button", { name: "打开协作面板" }),
    );
    await agent.waitFor({ state: "visible" });
  } finally {
    await context.close();
  }
});

test("Cowork Auto plans broad goals while Direct skips planning", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const cowork = coworkPane(page);
    await cowork
      .locator(".composer textarea")
      .fill("整体优化这个页面，让它更专业并提升转化");
    await clickParent(
      page,
      cowork.getByRole("button", { name: "发送" }),
    );
    await cowork.getByText("规划执行").waitFor();
    await cowork.getByText("Clarify hierarchy").waitFor();
    await cowork
      .locator(".message.working")
      .waitFor({ state: "hidden" });
    assert.ok(
      gatewayRequests.some((request) =>
        /mission planner/i.test(request.system),
      ),
    );

    const plannerCount = gatewayRequests.filter((request) =>
      /mission planner/i.test(request.system),
    ).length;
    await submit(page, "Change the heading to Direct mode");
    assert.equal(
      gatewayRequests.filter((request) =>
        /mission planner/i.test(request.system),
      ).length,
      plannerCount,
    );
  } finally {
    await context.close();
  }
});

test("stopping Cowork during mission planning preserves the checkpoint", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const cowork = coworkPane(page);
    const beforeVersion = await versionText(page);
    await cowork
      .locator(".composer textarea")
      .fill("E2E SLOW MISSION：整体改版这个页面并提升转化");
    await clickParent(
      page,
      cowork.getByRole("button", { name: "发送" }),
    );
    await cowork
      .locator(".stream-phase")
      .filter({ hasText: /^正在制定可执行任务计划$/ })
      .waitFor();
    await clickParent(
      page,
      cowork.getByRole("button", { name: "停止当前任务" }).last(),
    );
    await cowork.getByText("任务已停止").waitFor();
    assert.equal(await versionText(page), beforeVersion);
  } finally {
    await context.close();
  }
});

test("responsive unified Agent sidebar remains usable on tablet", async () => {
  const { context, page } = await newPage({
    width: 820,
    height: 900,
  });
  try {
    assert.equal(await coworkPane(page).isVisible(), true);
    const modeGroup = coworkPane(page).getByRole("group", {
      name: "协作模式",
    });
    await modeGroup.getByRole("button", { name: "Auto" }).waitFor();
    await modeGroup.getByRole("button", { name: "Plan" }).waitFor();
    await modeGroup.getByRole("button", { name: "Agent" }).waitFor();
  } finally {
    await context.close();
  }
});

test("blank model output is rejected without replacing the visible page", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const beforeVersion = await versionText(page);
    const heading = preview(page).getByRole("heading", {
      name: "Plan less. Go further.",
    });
    await heading.waitFor();
    await submit(page, "E2E BLANK");
    await heading.waitFor();
    assert.equal(await versionText(page), beforeVersion);
    await page.getByText("这次没有完成").last().waitFor();
  } finally {
    await context.close();
  }
});

test("blank project, source editing, undo, redo, export, and starter recovery", async () => {
  const { context, page } = await newPage();
  try {
    await clickParent(
      page,
      page.getByRole("button", { name: /Northstar landing/ }),
    );
    await clickParent(
      page,
      page.getByRole("button", { name: "新建空白页面" }),
    );
    await page.getByRole("button", { name: /未命名页面/ }).waitFor();
    assert.equal(await preview(page).locator("body").innerText(), "");

    await clickParent(
      page,
      page.locator(".tool-rail").getByRole("button", {
        name: "查看 HTML",
      }),
    );
    const source = `<!doctype html><html><body><main><h1>Source-created page</h1><button>Ship</button></main></body></html>`;
    await page.getByRole("textbox", { name: "HTML 源码" }).fill(source);
    await clickParent(
      page,
      page.getByRole("button", { name: "应用到画布" }),
    );
    await preview(page)
      .getByRole("heading", { name: "Source-created page" })
      .waitFor();

    await clickParent(page, page.getByRole("button", { name: "撤销" }));
    assert.equal(await preview(page).locator("body").innerText(), "");
    await clickParent(page, page.getByRole("button", { name: "重做" }));
    await preview(page)
      .getByRole("heading", { name: "Source-created page" })
      .waitFor();

    const downloadPromise = page.waitForEvent("download");
    await clickParent(
      page,
      page.getByRole("button", { name: "导出 HTML" }),
    );
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "未命名页面.html");
    const stream = await download.createReadStream();
    let exported = "";
    for await (const chunk of stream) exported += chunk.toString();
    assert.match(exported, /Source-created page/);

    await clickParent(
      page,
      page.getByRole("button", { name: /未命名页面/ }),
    );
    await clickParent(
      page,
      page.getByRole("button", { name: "恢复示例页面" }),
    );
    await preview(page)
      .getByRole("heading", { name: "Plan less. Go further." })
      .waitFor();
  } finally {
    await context.close();
  }
});

test("drawing tool captures visual context and applies a queued edit", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    await clickParent(
      page,
      page.getByRole("button", { name: "手绘标注 (B)" }),
    );
    const layer = page.locator(".interaction-layer");
    const box = await layer.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 180, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 190, { steps: 4 });
    await page.mouse.move(box.x + 320, box.y + 300, { steps: 4 });
    await page.mouse.move(box.x + 190, box.y + 320, { steps: 4 });
    await page.mouse.up();
    await page.getByText(/手绘标注/).last().waitFor();

    const beforeVersion = await versionText(page);
    await submit(page, "E2E COMPLETE");
    assert.notEqual(await versionText(page), beforeVersion);
    assert.equal(
      await preview(page).locator('[data-e2e-step="complete"]').count(),
      1,
    );
  } finally {
    await context.close();
  }
});

test("semantic navigation, inert control diagnostics, and solution fill", async () => {
  const { context, page } = await newPage();
  try {
    await clickParent(page, page.getByRole("button", { name: "操作页面 (P)" }));
    await page.evaluate(async () => {
      const frame = document.querySelector('iframe[title="HTML 页面预览"]');
      const link = frame?.contentDocument?.querySelector("a.secondary-btn");
      link?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.ok(await preview(page).locator("body").evaluate((body) => body.scrollTop > 0));
    assert.equal(await preview(page).getByText("Northstar", { exact: true }).count(), 1);

    await page.evaluate(async () => {
      const frame = document.querySelector('iframe[title="HTML 页面预览"]');
      const button = frame?.contentDocument?.createElement("button");
      if (!button || !frame?.contentDocument) return;
      button.textContent = "Open reports";
      frame.contentDocument.body.append(button);
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await page.getByText("导航需要补充配置").waitFor();
    assert.match(await page.locator(".cowork-report-issues").innerText(), /没有 href|不会执行 onclick/);
    await clickParent(page, page.getByRole("button", { name: /改为页内导航/ }));
    assert.match(
      await coworkPane(page).locator(".composer textarea").inputValue(),
      /<a href="#目标-id">/,
    );
  } finally {
    await context.close();
  }
});

test("completed, partial, and blocked reports manage versions correctly", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    await submit(page, "E2E BLOCKED");
    assert.match(await versionText(page), /1 \/ 1/);
    await page.getByText("需要你确认下一步").waitFor();
    assert.equal(await page.getByRole("button", { name: "撤销这次修改" }).count(), 0);
    assert.equal(await page.locator(".cowork-report-options button").count(), 2);

    await submit(page, "E2E COMPLETE");
    assert.match(await versionText(page), /2 \/ 2/);
    await page.getByText("页面更新已完成", { exact: true }).waitFor();
    assert.match(await page.locator(".cowork-report.completed").innerText(), /Added COMPLETE marker/);

    await submit(page, "E2E PARTIAL");
    assert.match(await versionText(page), /3 \/ 3/);
    await page.getByText("已完成可执行部分", { exact: true }).first().waitFor();
    assert.match(await page.locator(".cowork-report.partial").innerText(), /第二个目标缺少 URL/);
    assert.equal(await page.locator(".cowork-report.partial button").count(), 1);
  } finally {
    await context.close();
  }
});

test("Steer runs before Queue and every job receives the latest HTML", async () => {
  gatewayRequests.length = 0;
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const pane = coworkPane(page);
    const composer = pane.locator(".composer textarea");
    await composer.fill("E2E FIRST");
    await clickParent(page, pane.getByRole("button", { name: "发送" }));
    await pane.locator(".message.working").waitFor();

    await composer.fill("E2E QUEUE");
    await clickParent(page, pane.getByRole("button", { name: "加入队列" }));
    await composer.fill("E2E STEER");
    await clickParent(page, pane.getByRole("button", { name: "优先跟进" }));

    await page.waitForFunction(() => !document.querySelector(".message.working") && !document.querySelector(".active-agent-job") && !document.querySelector(".queued-agent-job"), null, { timeout: 30_000 });
    assert.match(await versionText(page), /4 \/ 4/);
    const queueRequests = gatewayRequests.filter(
      (item) =>
        isExecutionGatewayRequest(item) &&
        /E2E (FIRST|STEER|QUEUE)/.test(item.instruction),
    );
    assert.deepEqual(queueRequests.map((item) => item.instruction.split("\n")[0]), ["E2E FIRST", "E2E STEER", "E2E QUEUE"]);
    assert.match(queueRequests[1].html, /data-e2e-step="first"/);
    assert.match(queueRequests[2].html, /data-e2e-step="first"/);
    assert.match(queueRequests[2].html, /data-e2e-step="steer"/);
    assert.equal(await preview(page).locator('[data-e2e-step="queue"]').count(), 1);
    const steerRouter = gatewayRequests.find(
      (item) =>
        /unified coding-agent conversation/i.test(item.system) &&
        /E2E STEER/.test(item.user),
    );
    assert.ok(steerRouter);
    assert.doesNotMatch(
      steerRouter.user,
      /E2E QUEUE/,
      "Steer must not receive still-queued instructions as prior context",
    );
  } finally {
    await context.close();
  }
});

test("Plan stays advisory and does not create a version", async () => {
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const pane = coworkPane(page);
    await clickParent(
      page,
      pane
        .getByRole("group", { name: "协作模式" })
        .getByRole("button", { name: "Plan" }),
    );
    const composer = pane.locator(".composer textarea");
    await composer.fill("E2E CHAT");
    await clickParent(page, pane.getByRole("button", { name: "发送" }));
    await pane.locator(".message.streaming").waitFor({ state: "visible" });
    await pane.locator(".message.streaming").waitFor({ state: "hidden" });
    await pane.getByText("规划执行").waitFor();
    assert.match(await versionText(page), /1 \/ 1/);
  } finally {
    await context.close();
  }
});

test("element selection targets only the chosen card", async () => {
  gatewayRequests.length = 0;
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    await uploadHtml(page, "targeting.html", `<!doctype html><html><body><main>
      <article id="alpha"><h2>Alpha</h2><p>Keep alpha.</p></article>
      <article id="beta"><h2>Beta</h2><p>Change beta.</p></article>
    </main></body></html>`);
    await preview(page).locator("#beta").evaluate((element) => element.click());
    await coworkPane(page).locator(".selection-chip").waitFor();
    assert.match(
      await coworkPane(page).locator(".selection-chip").innerText(),
      /Beta/,
    );
    await submit(page, "E2E TARGET");
    assert.equal(await preview(page).locator("#alpha h2").innerText(), "Alpha");
    assert.equal(await preview(page).locator("#beta h2").innerText(), "Targeted Beta");
    const request = gatewayRequests.find(
      (item) =>
        isExecutionGatewayRequest(item) &&
        /E2E TARGET/.test(item.instruction),
    );
    assert.match(request?.user || "", /data-canvasly-edit-target/);
  } finally {
    await context.close();
  }
});

test("region selection creates content through the exact insertion slot", async () => {
  gatewayRequests.length = 0;
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    await uploadHtml(page, "region.html", `<!doctype html><html><head><style>
      body{margin:0;padding:40px}.stack{display:grid;gap:40px}.card{height:120px;border:1px solid #aaa}
    </style></head><body><main class="stack"><article id="before" class="card"><h2>Before</h2></article><article id="after" class="card"><h2>After</h2></article></main></body></html>`);
    await clickParent(page, page.getByRole("button", { name: "圈选区域 (R)" }));
    const before = await preview(page).locator("#before").boundingBox();
    const after = await preview(page).locator("#after").boundingBox();
    assert.ok(before && after);
    const layer = page.locator(".interaction-layer");
    const layerBox = await layer.boundingBox();
    assert.ok(layerBox);
    const top = (before.y + before.height + after.y) / 2;
    await page.mouse.move(layerBox.x + 80, top - 18);
    await page.mouse.down();
    await page.mouse.move(layerBox.x + Math.min(layerBox.width - 80, 700), top + 18, { steps: 4 });
    await page.mouse.up();
    await coworkPane(page).locator(".selection-chip").waitFor();
    await submit(page, "E2E REGION INSERT：在圈选位置添加一个 Region card 组件");
    assert.equal(await preview(page).locator("#e2e-region-card").count(), 1);
    const order = await preview(page).locator("main").evaluate((main) => Array.from(main.children).map((item) => item.id));
    assert.deepEqual(order, ["before", "e2e-region-card", "after"]);
    const request = gatewayRequests.find(
      (item) =>
        isExecutionGatewayRequest(item) &&
        /E2E REGION INSERT/.test(item.instruction),
    );
    assert.match(request?.html || "", /data-canvasly-insertion-slot/);
  } finally {
    await context.close();
  }
});

test("HTML upload and preview sanitizer remove executable content", async () => {
  const { context, page } = await newPage();
  try {
    await uploadHtml(page, "security-probe.html", `<!doctype html><html><body>
      <h1>Security probe</h1><button id="probe" onclick="window.__pwned=1">Probe</button>
      <a id="bad" href="javascript:window.__pwned=2">Bad</a><script>window.__pwned=3</script>
      <iframe srcdoc="<script>parent.__pwned=4</script>"></iframe>
    </body></html>`);
    assert.match(await page.getByRole("button", { name: /security-probe/ }).innerText(), /security-probe/i);
    const safety = await preview(page).locator("body").evaluate((body) => {
      const doc = body.ownerDocument;
      return {
        scripts: doc.querySelectorAll("script").length,
        frames: doc.querySelectorAll("iframe").length,
        onclick: doc.getElementById("probe")?.getAttribute("onclick") ?? null,
        badHref: doc.getElementById("bad")?.getAttribute("href") ?? null,
        pwned: doc.defaultView?.__pwned ?? null,
        csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") || "",
      };
    });
    assert.deepEqual({ scripts: safety.scripts, frames: safety.frames, onclick: safety.onclick, badHref: safety.badHref, pwned: safety.pwned }, { scripts: 0, frames: 0, onclick: null, badHref: null, pwned: null });
    assert.match(safety.csp, /script-src 'none'/);
  } finally {
    await context.close();
  }
});

test("free movement stages, confirms, and rolls back one batch", async () => {
  const { context, page } = await newPage();
  try {
    await clickParent(page, page.getByRole("button", { name: "移动组件 (M)" }));
    const card = preview(page).locator(".route-card");
    const box = await card.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 42, box.y + box.height / 2 + 24, { steps: 6 });
    await page.mouse.up();
    await page.getByRole("button", { name: /确认并渲染/ }).waitFor();
    await clickParent(page, page.getByRole("button", { name: /确认并渲染/ }));
    assert.match(await versionText(page), /2 \/ 2/);
    await page.getByRole("button", { name: /撤销移动/ }).waitFor();
    await clickParent(page, page.getByRole("button", { name: /撤销移动/ }));
    assert.match(await versionText(page), /1 \/ 2/);
    assert.equal(await page.getByRole("button", { name: "重做" }).isEnabled(), true);
  } finally {
    await context.close();
  }
});

test("prompt history restores commands and the unsent draft", async () => {
  const { context, page } = await newPage();
  try {
    await submit(page, "让主标题更醒目");
    await submit(page, "让右侧卡片变成深色");
    const composer = coworkPane(page).locator(".composer textarea");
    await composer.fill("未发送草稿");
    await composer.press("ArrowUp");
    assert.equal(await composer.inputValue(), "让右侧卡片变成深色");
    await composer.press("ArrowUp");
    assert.equal(await composer.inputValue(), "让主标题更醒目");
    await composer.press("ArrowDown");
    assert.equal(await composer.inputValue(), "让右侧卡片变成深色");
    await composer.press("ArrowDown");
    assert.equal(await composer.inputValue(), "未发送草稿");
  } finally {
    await context.close();
  }
});

test("IME composition Enter confirms text without sending", async () => {
  gatewayRequests.length = 0;
  const { context, page } = await newPage();
  try {
    await configureMock(page);
    const composer = coworkPane(page).locator(".composer textarea");
    await composer.fill("english from Chinese IME");
    await composer.dispatchEvent("compositionstart", { data: "english" });
    await composer.dispatchEvent("keydown", {
      key: "ArrowUp",
      code: "ArrowUp",
      isComposing: false,
      bubbles: true,
      cancelable: true,
    });
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      isComposing: false,
      bubbles: true,
      cancelable: true,
    });
    await page.waitForTimeout(100);

    assert.equal(await composer.inputValue(), "english from Chinese IME");
    assert.equal(gatewayRequests.length, 0);
    assert.equal(await page.locator(".message.user").count(), 0);
    assert.equal(await page.locator(".message.working").count(), 0);

    await composer.dispatchEvent("compositionend", { data: "english" });
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      which: 229,
      isComposing: false,
      bubbles: true,
      cancelable: true,
    });
    await page.waitForTimeout(50);
    assert.equal(gatewayRequests.length, 0);
    assert.equal(await composer.inputValue(), "english from Chinese IME");

    await composer.press("Enter");
    await page.locator(".message.working").waitFor({ state: "visible" });
    await page.locator(".message.working").waitFor({ state: "hidden" });
    assert.equal(
      gatewayRequests.filter(
        (item) =>
          isExecutionGatewayRequest(item) &&
          item.instruction === "english from Chinese IME",
      ).length,
      1,
    );
  } finally {
    await context.close();
  }
});

test("mobile execution report does not create horizontal overflow", async () => {
  const { context, page } = await newPage({ width: 390, height: 844 });
  try {
    await submit(page, "让主标题更醒目");
    const report = page.locator(".cowork-report").last();
    await report.waitFor();
    const box = await report.boundingBox();
    const viewport = await page.locator("html").evaluate((html) => ({ clientWidth: html.clientWidth, scrollWidth: html.scrollWidth }));
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.clientWidth);
    assert.equal(viewport.scrollWidth, viewport.clientWidth);
  } finally {
    await context.close();
  }
});