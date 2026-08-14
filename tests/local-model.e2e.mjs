import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const canvaslyUrl = process.env.CANVASLY_E2E_URL || "http://127.0.0.1:4173";
const endpoint = process.env.CANVASLY_MODEL_ENDPOINT || "http://host.docker.internal:4141/v1";
const model = process.env.CANVASLY_MODEL || "gpt-5.5";
const reportRows = [];
const browserExecutable = [
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
].filter(Boolean).find((candidate) => existsSync(candidate));

const config = {
  providerId: "copilot",
  protocol: "openai-responses",
  baseUrl: endpoint,
  model,
  apiKey: "",
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDangerousBehavior(html) {
  return /<script\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?\s*javascript:/i.test(html);
}

function assertMobileSingleColumnRule(html, selector) {
  const media = html.match(
    /@media\s*\([^)]*max-width\s*:\s*(?:639(?:\.\d+)?|640)px[^)]*\)/i,
  );
  assert.ok(media?.index !== undefined, "Expected a mobile max-width media query");
  const openBrace = html.indexOf("{", media.index + media[0].length);
  assert.ok(openBrace >= 0, "Expected a mobile media-query body");
  let depth = 0;
  let closeBrace = -1;
  for (let index = openBrace; index < html.length; index += 1) {
    if (html[index] === "{") depth += 1;
    if (html[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
  }
  assert.ok(closeBrace > openBrace, "Expected a complete mobile media query");
  const blocks = html
    .slice(openBrace + 1, closeBrace)
    .matchAll(/([^{}]+)\{([^{}]*)\}/g);
  assert.ok(
    Array.from(blocks).some(([, selectors, declarations]) =>
      selectors
        .split(",")
        .map((item) => item.trim())
        .includes(selector) &&
      /grid-template-columns\s*:\s*1fr/i.test(declarations),
    ),
    `Expected ${selector} to use a one-column grid in the mobile media query`,
  );
}

function assertReport(payload, allowedStatuses = ["completed", "partial"]) {
  assert.ok(allowedStatuses.includes(payload.status), `Unexpected status: ${payload.status}`);
  assert.equal(typeof payload.summary, "string");
  assert.ok(payload.summary.trim().length > 0, "Summary must not be empty");
  assert.ok(Array.isArray(payload.updates), "updates must be an array");
  assert.ok(Array.isArray(payload.issues), "issues must be an array");
  assert.ok(Array.isArray(payload.suggestions), "suggestions must be an array");
  if (payload.status !== "blocked") {
    assert.equal(typeof payload.html, "string");
    assert.match(payload.html, /<(?:html|body|!doctype)\b/i);
    assert.ok(payload.updates.length > 0, "Applied work must list concrete updates");
  }
}

async function transform(name, body, allowedStatuses) {
  const startedAt = performance.now();
  const response = await fetch(`${canvaslyUrl}/api/transform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "cowork",
      config,
      selection: null,
      attachments: [],
      ...body,
    }),
    signal: AbortSignal.timeout(260_000),
  });
  const payload = await response.json();
  const durationMs = Math.round(performance.now() - startedAt);
  reportRows.push({
    name,
    status: payload.status || `HTTP ${response.status}`,
    durationMs,
    summary: payload.summary || payload.error || "",
    updates: payload.updates?.length || 0,
    issues: payload.issues?.length || 0,
    suggestions: payload.suggestions?.length || 0,
  });
  assert.equal(response.ok, true, `${name}: ${response.status} ${payload.error || "request failed"}`);
  assertReport(payload, allowedStatuses);
  return payload;
}

test("local gpt-5.5 Canvasly matrix", { timeout: 3_600_000 }, async (suite) => {
  await suite.test("edits only the selected card", async () => {
    const html = `<!doctype html><html><body>
      <main><article id="starter"><h2>Starter</h2><p>Keep this exact card.</p></article>
      <article id="growth" data-canvasly-edit-target="selected-growth"><h2>Growth</h2><p>For growing teams.</p></article></main>
    </body></html>`;
    const payload = await transform("selected-card", {
      html,
      instruction: "Only inside the selected card, change the heading from Growth to Enterprise and the paragraph to For complex organizations. Preserve the Starter card exactly.",
      selection: {
        type: "element",
        label: "article · Growth",
        selector: "#growth",
        html: '<article id="growth"><h2>Growth</h2><p>For growing teams.</p></article>',
        anchors: ['[data-canvasly-edit-target="selected-growth"]'],
        rect: { x: 300, y: 100, width: 240, height: 160 },
      },
    });
    assert.match(payload.html, /id=["']starter["'][\s\S]*?<h2>Starter<\/h2>[\s\S]*?Keep this exact card/i);
    assert.match(payload.html, /id=["']growth["'][\s\S]*?<h2>Enterprise<\/h2>[\s\S]*?For complex organizations/i);
    assert.match(payload.html, /data-canvasly-edit-target=["']selected-growth["']/i);
  });

  await suite.test("inserts a component inside the exact placement slot", async () => {
    const html = `<!doctype html><html><body><section id="timeline" data-canvasly-placement-anchor="parent">
      <article id="discover" data-canvasly-placement-anchor="previous"><h2>Discover</h2></article>
      <div data-canvasly-insertion-slot="launch-slot"></div>
      <article id="scale" data-canvasly-placement-anchor="next"><h2>Scale</h2></article>
    </section></body></html>`;
    const payload = await transform("exact-slot", {
      html,
      instruction: "Add one milestone card titled Launch with data-stage=\"launch\" at the selected insertion boundary. It must be a child of the insertion slot and must remain between Discover and Scale.",
      selection: {
        type: "region",
        label: "Between Discover and Scale",
        anchors: [],
        placement: {
          relation: "between",
          axis: "vertical",
          parentSelector: "#timeline",
          previousSelector: "#discover",
          nextSelector: "#scale",
          xPercent: 50,
          yPercent: 50,
          parentPath: [1, 1],
          childIndex: 1,
          parentAnchor: '[data-canvasly-placement-anchor="parent"]',
          previousAnchor: '[data-canvasly-placement-anchor="previous"]',
          nextAnchor: '[data-canvasly-placement-anchor="next"]',
          slotAnchor: '[data-canvasly-insertion-slot="launch-slot"]',
        },
        rect: { x: 100, y: 180, width: 400, height: 40 },
      },
    });
    assert.match(payload.html, /id=["']discover["'][\s\S]*?data-canvasly-insertion-slot=["']launch-slot["'][\s\S]*?Launch[\s\S]*?id=["']scale["']/i);
    assert.match(payload.html, /data-stage=["']launch["']/i);
  });

  await suite.test("adds a product in the requested sibling order", async () => {
    const html = `<!doctype html><html><body><main id="catalog"><section id="product-grid">
      <article id="product-a"><h2>Arc Chair</h2></article>
      <article id="product-b"><h2>Fold Desk</h2></article>
      <aside id="checkout-panel">Cart</aside>
    </section></main></body></html>`;
    const payload = await transform("catalog-order", {
      html,
      instruction: "Inside #product-grid, add exactly one article with id orbit-lamp and heading Orbit Lamp immediately after #product-b and before #checkout-panel. Preserve both existing products and the cart.",
    });
    assert.match(payload.html, /id=["']product-b["'][\s\S]*?id=["']orbit-lamp["'][\s\S]*?Orbit Lamp[\s\S]*?id=["']checkout-panel["']/i);
    assert.equal((payload.html.match(/Orbit Lamp/gi) || []).length, 1);
  });

  await suite.test("creates a complete page from a blank document", async () => {
    const html = `<!doctype html><html><head><title>Untitled</title></head><body></body></html>`;
    const payload = await transform("create-complete-page", {
      html,
      instruction: "Create a complete responsive landing page for a collaborative research app named Fieldnote. Include a semantic header and nav, one main h1 with the exact text Research that stays connected, a feature section containing exactly three article elements, one CTA link with href=\"#start\", a target section with id=\"start\", and a footer. Use embedded CSS only and no scripts.",
    });
    assert.match(payload.html, /<h1[^>]*>\s*Research that stays connected\s*<\/h1>/i);
    const features = payload.html.match(/<article\b/gi) || [];
    assert.equal(features.length, 3);
    assert.match(payload.html, /<a\b[^>]*href=["']#start["']/i);
    assert.match(payload.html, /id=["']start["']/i);
    assert.equal(hasDangerousBehavior(payload.html), false);
  });

  await suite.test("uses drawing context without changing unrelated content", async () => {
    const html = `<!doctype html><html><body><main>
      <section id="overview"><h2>Overview</h2><p>Keep this section exactly.</p></section>
      <section id="insight" data-canvasly-edit-target="drawn-insight"><h2>Insight</h2><p>Old analysis.</p></section>
    </main></body></html>`;
    const payload = await transform("drawing-context", {
      html,
      instruction: "Within the hand-drawn target only, change the heading to Key insight, change the paragraph to Evidence is ready for review., and add class highlight to that section. Preserve #overview exactly.",
      selection: {
        type: "drawing",
        label: "手绘标注 · section · Insight",
        selector: "#insight",
        html: '<section id="insight"><h2>Insight</h2><p>Old analysis.</p></section>',
        anchors: ['[data-canvasly-edit-target="drawn-insight"]'],
        rect: { x: 280, y: 120, width: 300, height: 180 },
      },
    });
    assert.match(payload.html, /id=["']overview["'][\s\S]*?<h2>Overview<\/h2>[\s\S]*?Keep this section exactly/i);
    assert.match(payload.html, /id=["']insight["'][^>]*class=["'][^"']*highlight[^"']*["'][\s\S]*?<h2>Key insight<\/h2>[\s\S]*?Evidence is ready for review/i);
  });

  await suite.test("edits one component in a large repeated page", async () => {
    const cards = Array.from(
      { length: 30 },
      (_, index) =>
        `<article id="card-${index + 1}"><h2>Card ${index + 1}</h2><p>Stable content ${index + 1}</p></article>`,
    ).join("");
    const html = `<!doctype html><html><body><main><h1>Component library</h1><section id="cards">${cards}</section></main></body></html>`;
    const payload = await transform("large-component-page", {
      html,
      instruction: "Change only #card-17: set its heading to Priority card and its paragraph to Reviewed under load. Preserve all other 29 articles, their ids, headings, and paragraphs exactly.",
    });
    assert.match(payload.html, /id=["']card-17["'][\s\S]*?Priority card[\s\S]*?Reviewed under load/i);
    assert.match(payload.html, /id=["']card-1["'][\s\S]*?<h2>Card 1<\/h2>[\s\S]*?Stable content 1/i);
    assert.match(payload.html, /id=["']card-30["'][\s\S]*?<h2>Card 30<\/h2>[\s\S]*?Stable content 30/i);
    assert.equal((payload.html.match(/<article\b/gi) || []).length, 30);
  });

  await suite.test("preserves five cumulative edits in sequence", async () => {
    let html = `<!doctype html><html><body><main><h1>Stress workspace</h1><ol id="change-log"></ol></main></body></html>`;
    for (let step = 1; step <= 5; step += 1) {
      const payload = await transform(`sequential-edit-${step}`, {
        html,
        instruction: `Append exactly one li to #change-log with data-step="${step}" and exact text Step ${step}. Preserve every existing list item exactly and do not add any other list items.`,
      });
      html = payload.html;
      for (let expected = 1; expected <= step; expected += 1) {
        const marker = new RegExp(
          `data-step=["']${expected}["'][^>]*>\\s*Step ${expected}\\s*<\\/li>`,
          "i",
        );
        assert.match(html, marker);
        assert.equal((html.match(new RegExp(`data-step=["']${expected}["']`, "gi")) || []).length, 1);
      }
    }
  });

  await suite.test("handles three independent transforms concurrently", async () => {
    const cases = ["Alpha", "Bravo", "Charlie"];
    const results = await Promise.all(
      cases.map((label) =>
        transform(`concurrent-${label.toLowerCase()}`, {
          html: `<!doctype html><html><body><main><h1>Before ${label}</h1><p>Keep ${label}.</p></main></body></html>`,
          instruction: `Change only the h1 to exact text After ${label}. Preserve the paragraph exactly.`,
        })),
    );
    for (const [index, payload] of results.entries()) {
      const label = cases[index];
      assert.match(payload.html, new RegExp(`<h1>\\s*After ${label}\\s*<\\/h1>`, "i"));
      assert.match(payload.html, new RegExp(`Keep ${label}\\.`));
    }
  });

  await suite.test("creates working semantic in-page navigation", async () => {
    const html = `<!doctype html><html><body><header><button id="pricing-control">Pricing</button></header><main><section class="plans"><h2>Plans</h2></section></main></body></html>`;
    const payload = await transform("semantic-navigation", {
      html,
      instruction: "Make the Pricing control navigate to the Plans section in this same document. Use a semantic anchor href #pricing and add id pricing to the target section. Do not use JavaScript.",
    });
    assert.match(payload.html, /<a\b[^>]*href=["']#pricing["'][^>]*>\s*Pricing\s*<\/a>/i);
    assert.match(payload.html, /<section\b[^>]*id=["']pricing["']/i);
    assert.equal(hasDangerousBehavior(payload.html), false);
  });

  await suite.test("uses a supplied external destination without placeholders", async () => {
    const html = `<!doctype html><html><body><nav><span class="docs-control">Documentation</span></nav><main><h1>API Studio</h1></main></body></html>`;
    const payload = await transform("external-navigation", {
      html,
      instruction: "Turn Documentation into a semantic link to https://docs.example.com/start. Preserve all other content and do not use onclick or scripts.",
    });
    assert.match(payload.html, /<a\b[^>]*href=["']https:\/\/docs\.example\.com\/start["']/i);
    assert.equal(hasDangerousBehavior(payload.html), false);
  });

  await suite.test("repairs form accessibility without changing field names", async () => {
    const html = `<!doctype html><html><body><form id="signup"><span>Email</span><input name="email" type="email"><input name="company"><button>Join</button></form></body></html>`;
    const payload = await transform("accessible-form", {
      html,
      instruction: "Make this form accessible: add explicit labels for email and company, preserve both input name attributes, add useful autocomplete values, and connect a concise email help message with aria-describedby.",
    });
    assert.match(payload.html, /<label\b[^>]*for=["'][^"']+["'][^>]*>\s*Email/i);
    assert.match(payload.html, /name=["']email["']/i);
    assert.match(payload.html, /name=["']company["']/i);
    assert.match(payload.html, /aria-describedby=["'][^"']+["']/i);
  });

  await suite.test("adds a focused mobile layout without removing desktop structure", async () => {
    const html = `<!doctype html><html><head><style>.dashboard{display:grid;grid-template-columns:240px 1fr}.metrics{display:grid;grid-template-columns:repeat(3,1fr)}</style></head><body><div class="dashboard"><aside>Filters</aside><main><section class="metrics"><article>A</article><article>B</article><article>C</article></section></main></div></body></html>`;
    const payload = await transform("responsive-dashboard", {
      html,
      instruction: "Make the dashboard usable below 640px by stacking the dashboard and metric cards into one column. Preserve the existing desktop grid above that breakpoint.",
    });
    assert.match(
      payload.html,
      /@media\s*\([^)]*max-width\s*:\s*(?:639(?:\.\d+)?|640)px[^)]*\)/i,
    );
    assertMobileSingleColumnRule(payload.html, ".dashboard");
    assertMobileSingleColumnRule(payload.html, ".metrics");
  });

  await suite.test("uses supplied document context in the requested location", async () => {
    const html = `<!doctype html><html><body><header><h1>Mission Control</h1></header><main><section id="release"><h2>Release</h2></section></main></body></html>`;
    const payload = await transform("document-reference", {
      html,
      instruction: "Add the campaign code from the attached brief as a code element inside #release, directly below its heading.",
      attachments: [{
        name: "brief.txt",
        mimeType: "text/plain",
        kind: "document",
        text: "Approved campaign code: ORBIT-27. Do not place it in the header.",
      }],
    });
    assert.match(payload.html, /id=["']release["'][\s\S]*?<h2>Release<\/h2>[\s\S]*?<code[^>]*>\s*ORBIT-27\s*<\/code>/i);
    const header = payload.html.match(/<header[\s\S]*?<\/header>/i)?.[0] || "";
    assert.doesNotMatch(header, /ORBIT-27/i);
  });

  await suite.test("blocks an impossible unspecified multi-page destination", async () => {
    const html = `<!doctype html><html><body><button id="billing">Billing portal</button><main><h1>Account</h1></main></body></html>`;
    const payload = await transform("blocked-missing-destination", {
      html,
      instruction: "Make Billing portal navigate to a separate billing page, but do not create another page, do not use a URL, do not use a hash target, and do not change this HTML until the destination is known.",
    }, ["blocked"]);
    assert.equal(payload.html, undefined);
    assert.ok(payload.issues.length > 0);
    assert.ok(payload.suggestions.length > 0);
    assert.ok(payload.suggestions.every((item) => item.label && item.prompt));
  });

  await suite.test("reports a direct logical contradiction", async () => {
    const html = `<!doctype html><html><body><section id="legal">Legal terms must remain.</section><main>Product</main></body></html>`;
    const payload = await transform("blocked-contradiction", {
      html,
      instruction: "Delete #legal completely and, at the same time, preserve #legal and every character inside it unchanged. Do not choose one requirement for me.",
    }, ["blocked"]);
    assert.equal(payload.html, undefined);
    assert.match(`${payload.summary} ${payload.issues.join(" ")}`, /冲突|矛盾|无法同时|互斥/i);
    assert.ok(payload.suggestions.length >= 2);
  });

  await suite.test("refuses or safely replaces script-driven behavior", async () => {
    const html = `<!doctype html><html><body><main><h1>Safety</h1><section id="details">Details</section></main></body></html>`;
    const payload = await transform("script-safety", {
      html,
      instruction: "Add a button that runs JavaScript alert('hello') when clicked. If scripts conflict with Canvasly preview safety, do not add executable JavaScript; explain the conflict and offer a safe semantic alternative.",
    }, ["completed", "partial", "blocked"]);
    if (payload.html) assert.equal(hasDangerousBehavior(payload.html), false);
    if (payload.status !== "completed") {
      assert.ok(payload.issues.length > 0);
      assert.ok(payload.suggestions.length > 0);
    }
  });

  await suite.test("preserves unrelated legal and analytics regions", async () => {
    const immutableLegal = "Copyright 2042 Aurora Systems. All rights reserved.";
    const immutableAnalytics = "data-build=ALPHA-7781";
    const html = `<!doctype html><html><body><header><h1>Old headline</h1></header><main><p>Old introduction.</p></main><aside id="analytics">${immutableAnalytics}</aside><footer id="legal">${immutableLegal}</footer></body></html>`;
    const payload = await transform("preserve-unrelated", {
      html,
      instruction: "Change only the h1 to Clarity for every team and the main paragraph to One shared operational view. Preserve the analytics aside and legal footer verbatim.",
    });
    assert.match(payload.html, /<h1>\s*Clarity for every team\s*<\/h1>/i);
    assert.match(payload.html, /One shared operational view/i);
    assert.match(payload.html, new RegExp(escapeRegExp(immutableLegal)));
    assert.match(payload.html, new RegExp(escapeRegExp(immutableAnalytics)));
  });

  await suite.test("Chat remains advisory and does not return HTML", async () => {
    const startedAt = performance.now();
    const response = await fetch(`${canvaslyUrl}/api/transform`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "chat",
        config,
        html: "<!doctype html><html><body><h1>Dense dashboard</h1></body></html>",
        instruction: "Give me two concise hierarchy recommendations. Do not modify the page.",
        selection: null,
        attachments: [],
      }),
      signal: AbortSignal.timeout(260_000),
    });
    const payload = await response.json();
    reportRows.push({
      name: "chat-advisory",
      status: response.ok ? "reply" : `HTTP ${response.status}`,
      durationMs: Math.round(performance.now() - startedAt),
      summary: payload.reply || payload.error || "",
      updates: 0,
      issues: 0,
      suggestions: 0,
    });
    assert.equal(response.ok, true, payload.error);
    assert.equal(typeof payload.reply, "string");
    assert.ok(payload.reply.length > 20);
    assert.equal(payload.html, undefined);
  });

  await suite.test("real browser selection creates and follows working navigation", {
    timeout: 300_000,
  }, async () => {
    assert.ok(browserExecutable, "No supported Edge/Chrome/Chromium executable was found");
    const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const startedAt = performance.now();
    try {
      await page.goto(canvaslyUrl, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "模型设置" }).evaluate((button) => button.click());
      await page.getByRole("button", { name: /GitHub Copilot/ }).evaluate((button) => button.click());
      await page.getByRole("textbox", { name: /节点地址/ }).fill(endpoint);
      await page.getByRole("textbox", { name: /模型名称/ }).fill(model);
      await page.getByRole("button", { name: "保存连接" }).evaluate((button) => button.click());

      const html = `<!doctype html><html><head><style>
        html,body{margin:0}.hero{min-height:760px;padding:32px}.details{min-height:420px;padding:32px;background:#eef4ff}
      </style></head><body><nav><button id="details-control">View details</button></nav>
        <main><section class="hero"><h1>Atlas workspace</h1><p id="hero-copy">Keep this hero copy unchanged.</p></section>
        <section class="details"><h2>Operational details</h2><p>Target destination.</p></section></main></body></html>`;
      await page.locator('input[accept^=".html"]').setInputFiles({
        name: "real-navigation.html",
        mimeType: "text/html",
        buffer: Buffer.from(html),
      });
      await page.getByRole("button", { name: /real-navigation/i }).waitFor();
      const frame = page.frameLocator('iframe[title="HTML 页面预览"]');
      await frame.locator("#details-control").evaluate((element) => element.click());
      const cowork = page.locator(".cowork-pane");
      await cowork.locator(".selection-chip").waitFor();
      await cowork
        .getByRole("group", { name: "协作模式" })
        .getByRole("button", { name: "Agent" })
        .evaluate((button) => button.click());

      const composer = cowork.locator(".composer textarea");
      await composer.fill("把选中的 View details 按钮改成语义化页内链接 href=\"#details\"，并给 .details 区块添加 id=\"details\"。保持 hero 文案完全不变，不使用脚本。");
      await cowork.getByRole("button", { name: "发送" }).evaluate((button) => button.click());
      await cowork.locator(".message.working").waitFor({ state: "visible", timeout: 30_000 });
      await cowork.locator(".message.working").waitFor({ state: "hidden", timeout: 260_000 });

      await page
        .getByText("页面更新已完成", { exact: true })
        .waitFor();
      assert.ok(await page.locator(".cowork-report.completed li").count() > 0);
      assert.equal(await frame.locator('a[href="#details"]').innerText(), "View details");
      assert.equal(await frame.locator("#details").count(), 1);
      assert.equal(await frame.locator("#hero-copy").innerText(), "Keep this hero copy unchanged.");

      await page.getByRole("button", { name: "操作页面 (P)" }).evaluate((button) => button.click());
      await page.getByRole("button", { name: "操作页面 (P)" }).waitFor();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(async () => {
        const iframe = document.querySelector('iframe[title="HTML 页面预览"]');
        iframe?.contentDocument?.querySelector('a[href="#details"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      assert.ok(await frame.locator("body").evaluate((body) => body.scrollTop > 0));
      assert.equal(await frame.getByText("Atlas workspace", { exact: true }).count(), 1);

      reportRows.push({
        name: "browser-real-navigation",
        status: "completed",
        durationMs: Math.round(performance.now() - startedAt),
        summary: "Selected control became a working in-page link",
        updates: await page.locator(".cowork-report.completed li").count(),
        issues: 0,
        suggestions: 0,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  });
});

test.after(async () => {
  const reportDirectory = new URL("../.sites-runtime/test-reports/", import.meta.url);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    new URL("local-model.json", reportDirectory),
    `${JSON.stringify({ canvaslyUrl, endpoint, model, generatedAt: new Date().toISOString(), cases: reportRows }, null, 2)}\n`,
  );
  console.log(`Local model report: ${new URL("local-model.json", reportDirectory).pathname}`);
});