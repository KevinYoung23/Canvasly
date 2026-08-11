import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const canvaslyUrl = process.env.CANVASLY_E2E_URL || "http://127.0.0.1:4173";
const gatewayPort = Number(process.env.CANVASLY_API_MOCK_PORT || 4144);
const retryPort = gatewayPort + 1;
const requests = [];
let gateway;

const baseHtml = "<!doctype html><html><body><h1>Before</h1></body></html>";

function completedHtml(label = "After") {
  return `<!doctype html><html><body><h1>${label}</h1></body></html>`;
}

function responseEnvelope(result) {
  return { object: "response", output_text: typeof result === "string" ? result : JSON.stringify(result) };
}

function structuredResult(label = "After") {
  return {
    status: "completed",
    html: completedHtml(label),
    summary: `Updated to ${label}`,
    updates: [`Changed heading to ${label}`],
    issues: [],
    suggestions: [],
  };
}

async function startGateway(port, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  return server;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function post(body, { raw = false } = {}) {
  const response = await fetch(`${canvaslyUrl}/api/transform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

function validBody(overrides = {}) {
  return {
    mode: "cowork",
    config: {
      providerId: "custom",
      protocol: "openai-responses",
      baseUrl: `http://host.docker.internal:${gatewayPort}/v1`,
      model: "normal",
      apiKey: "",
    },
    html: baseHtml,
    instruction: "Update the heading.",
    selection: null,
    attachments: [],
    ...overrides,
  };
}

test.before(async () => {
  const health = await fetch(canvaslyUrl);
  assert.equal(health.ok, true, `Canvasly is not reachable at ${canvaslyUrl}`);
  gateway = await startGateway(gatewayPort, async (request, response) => {
    const rawBody = await readBody(request);
    const payload = JSON.parse(rawBody || "{}");
    requests.push({ url: request.url, headers: request.headers, payload });
    const model = payload.model;

    if (model === "redirect") {
      response.writeHead(302, { location: "https://example.com/model" });
      response.end();
      return;
    }
    if (model === "non-json") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not json");
      return;
    }
    if (model === "upstream-error") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "quota probe" } }));
      return;
    }

    let result;
    if (model === "blocked") {
      result = {
        status: "blocked",
        summary: "Need a destination",
        updates: [],
        issues: ["Destination is missing"],
        suggestions: [{ label: "Provide URL", prompt: "Use https://example.com" }],
      };
    } else if (model === "legacy") {
      result = { html: completedHtml("Legacy"), summary: "Legacy update" };
    } else if (model === "fenced") {
      result = `\`\`\`json\n${JSON.stringify(structuredResult("Fenced"))}\n\`\`\``;
    } else {
      const systemText = (payload.input || [])
        .filter((item) => item.role === "system")
        .flatMap((item) => item.content || [])
        .map((item) => item.text || "")
        .join("\n");
      result = /Canvasly Chat/.test(systemText)
        ? { reply: "Advisory API reply" }
        : structuredResult("Normal");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseEnvelope(result)));
  });
});

test.after(async () => {
  if (gateway?.listening) await new Promise((resolve) => gateway.close(resolve));
});

test("rejects malformed JSON", async () => {
  const { response, payload } = await post("{", { raw: true });
  assert.equal(response.status, 400);
  assert.match(payload.error, /有效的 JSON/);
});

test("rejects missing model configuration", async () => {
  const { response, payload } = await post({ html: baseHtml, instruction: "Test" });
  assert.equal(response.status, 400);
  assert.match(payload.error, /配置不完整/);
});

test("rejects unsupported protocols", async () => {
  const body = validBody();
  body.config.protocol = "unsupported";
  const { response, payload } = await post(body);
  assert.equal(response.status, 400);
  assert.match(payload.error, /不支持的模型协议/);
});

test("requires HTTPS for non-private HTTP endpoints", async () => {
  const body = validBody();
  body.config.baseUrl = "http://example.com/v1";
  const { response, payload } = await post(body);
  assert.equal(response.status, 400);
  assert.match(payload.error, /必须使用 HTTPS/);
});

test("rejects credentials embedded in endpoint URLs", async () => {
  const body = validBody();
  body.config.baseUrl = `http://user:password@host.docker.internal:${gatewayPort}/v1`;
  const { response, payload } = await post(body);
  assert.equal(response.status, 400);
  assert.match(payload.error, /用户名或密码/);
});

test("enforces HTML and instruction limits", async () => {
  const oversizedHtml = await post(validBody({ html: `<!doctype html><body>${"x".repeat(300_001)}</body>` }));
  assert.equal(oversizedHtml.response.status, 400);
  assert.match(oversizedHtml.payload.error, /HTML 不能为空且不能超过/);

  const oversizedInstruction = await post(validBody({ instruction: "x".repeat(12_001) }));
  assert.equal(oversizedInstruction.response.status, 400);
  assert.match(oversizedInstruction.payload.error, /编辑描述为空或过长/);
});

test("normalizes the Responses path and forwards bearer authentication", async () => {
  const before = requests.length;
  const body = validBody();
  body.config.apiKey = "e2e-secret";
  const { response, payload } = await post(body);
  assert.equal(response.status, 200);
  assert.equal(payload.status, "completed");
  const request = requests[before];
  assert.equal(request.url, "/v1/responses");
  assert.equal(request.headers.authorization, "Bearer e2e-secret");
  assert.equal(request.payload.store, false);
});

test("accepts blocked reports without HTML", async () => {
  const body = validBody();
  body.config.model = "blocked";
  const { response, payload } = await post(body);
  assert.equal(response.status, 200);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.html, undefined);
  assert.deepEqual(payload.issues, ["Destination is missing"]);
  assert.equal(payload.suggestions.length, 1);
});

test("normalizes legacy and fenced model responses", async () => {
  for (const [model, heading] of [["legacy", "Legacy"], ["fenced", "Fenced"]]) {
    const body = validBody();
    body.config.model = model;
    const { response, payload } = await post(body);
    assert.equal(response.status, 200);
    assert.equal(payload.status, "completed");
    assert.match(payload.html, new RegExp(`<h1>${heading}<\\/h1>`));
    assert.ok(payload.updates.length > 0);
  }
});

test("rejects redirects, non-JSON responses, and upstream errors", async () => {
  for (const [model, expected] of [
    ["redirect", /重定向/],
    ["non-json", /非 JSON/],
    ["upstream-error", /quota probe/],
  ]) {
    const body = validBody();
    body.config.model = model;
    const { response, payload } = await post(body);
    assert.equal(response.status, 502);
    assert.match(payload.error, expected);
  }
});

test("Chat returns advice without HTML", async () => {
  const { response, payload } = await post(validBody({ mode: "chat" }));
  assert.equal(response.status, 200);
  assert.equal(payload.reply, "Advisory API reply");
  assert.equal(payload.html, undefined);
});

test("retries one refused connection when the model gateway becomes available", { timeout: 10_000 }, async () => {
  const body = validBody();
  body.config.baseUrl = `http://host.docker.internal:${retryPort}/v1`;
  body.config.model = "retry";

  const pending = post(body);
  let retryGateway;
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    retryGateway = await startGateway(retryPort, async (request, response) => {
      await readBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseEnvelope(structuredResult("Retried"))));
    });
    const { response, payload } = await pending;
    assert.equal(response.status, 200);
    assert.equal(payload.status, "completed");
    assert.match(payload.html, /<h1>Retried<\/h1>/);
  } finally {
    if (retryGateway?.listening) await new Promise((resolve) => retryGateway.close(resolve));
  }
});