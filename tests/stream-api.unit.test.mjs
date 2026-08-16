import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

async function bundle(entry) {
  const output = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
  });
  const source = output.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const [{ POST }, sseModule] = await Promise.all([
  bundle("app/api/stream/route.ts"),
  bundle("app/api/_lib/sse.ts"),
]);

const originalFetch = globalThis.fetch;
const html = "<!doctype html><html><body><h1>Before</h1></body></html>";

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function body(overrides = {}) {
  return {
    mode: "chat",
    config: {
      providerId: "custom",
      protocol: "openai-chat",
      baseUrl: "https://models.example/v1",
      model: "test-model",
      apiKey: "",
    },
    html,
    instruction: "Help me improve this heading.",
    selection: null,
    attachments: [],
    history: [],
    ...overrides,
  };
}

function request(payload, signal, headers = {}) {
  return new Request("https://canvasly.example/api/stream", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
}

function providerStream(chunks, contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

function events(source) {
  return source
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice(7),
        data: JSON.parse(
          lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n"),
        ),
      };
    });
}

test("parses split, CRLF, multiline SSE chunks and translates provider deltas", () => {
  const parser = new sseModule.SSEChunkParser();
  assert.deepEqual(parser.push("event: response.output_text.delta\r\ndata: {\"type\":"), []);
  const parsed = parser.push(
    "\"response.output_text.delta\",\r\ndata: \"delta\":\"Hi\"}\r\n\r\n",
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].data, '{"type":"response.output_text.delta",\n"delta":"Hi"}');

  const translated = sseModule.translateProviderEvent(
    "anthropic",
    {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      }),
    },
  );
  assert.deepEqual(translated, [{ type: "delta", text: "Hello" }]);
});

test("accepts multiple bounded SSE events delivered in one large chunk", () => {
  const parser = new sseModule.SSEChunkParser();
  const combined = Array.from(
    { length: 6 },
    (_, index) =>
      `event: part-${index}\ndata: ${"x".repeat(200_000)}\n\n`,
  ).join("");
  const parsed = parser.push(combined);
  assert.equal(parsed.length, 6);
  assert.ok(
    parsed.every((event) => event.data.length === 200_000),
  );
});

test("streams Chat deltas and normalized safe citations", async () => {
  globalThis.fetch = async () =>
    providerStream([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com/a#fragment","title":"Example","content":"proof"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const response = await POST(request(body()));
  const result = events(await response.text());
  assert.deepEqual(
    result.filter((item) => item.event === "delta").map((item) => item.data.text),
    ["Hello ", "world"],
  );
  const citation = result.find((item) => item.event === "citation").data;
  assert.equal(citation.url, "https://example.com/a");
  assert.equal(citation.title, "Example");
  const final = result.find((item) => item.event === "result").data;
  assert.equal(final.reply, "Hello world");
  assert.equal(final.searchSupported, false);
  assert.match(final.searchReason, /支持列表/);
  assert.deepEqual(result.at(-1), {
    event: "done",
    data: { stopped: false },
  });
});

test("accepts HTML above the former 300,000 character limit", async () => {
  globalThis.fetch = async () =>
    providerStream([
      'data: {"choices":[{"delta":{"content":"Large page accepted"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const output = events(
    await (
      await POST(
        request(
          body({
            html: `<!doctype html><html><body>${"x".repeat(
              300_001,
            )}</body></html>`,
          }),
        ),
      )
    ).text(),
  );
  assert.equal(
    output.find((item) => item.event === "result").data.reply,
    "Large page accepted",
  );
});

test("buffers Cowork JSON, emits factual phases, then validates result", async () => {
  const report = JSON.stringify({
    status: "completed",
    html: "<!doctype html><html><body><h1>After</h1></body></html>",
    summary: "Updated heading",
    updates: ["Changed heading"],
    issues: [],
    suggestions: [],
  });
  globalThis.fetch = async () =>
    providerStream([
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: report.slice(0, 50),
      })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: report.slice(50),
      })}\n\n`,
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  const payload = body({
    mode: "cowork",
    config: {
      ...body().config,
      protocol: "openai-responses",
    },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(result.some((item) => item.event === "delta"), false);
  assert.deepEqual(
    result.filter((item) => item.event === "phase").map((item) => item.data.stage),
    ["connecting", "classification", "generating", "validating"],
  );
  assert.equal(result.find((item) => item.event === "result").data.status, "completed");
});

test("accepts full-page output above the former one-million character limit", async () => {
  const report = JSON.stringify({
    status: "completed",
    html: `<!doctype html><html><body>${"x".repeat(
      1_050_000,
    )}</body></html>`,
    summary: "Returned the complete large page",
    updates: ["Preserved the full document"],
    issues: [],
    suggestions: [],
  });
  globalThis.fetch = async () =>
    providerStream([
      ...Array.from(
        { length: Math.ceil(report.length / 200_000) },
        (_, index) =>
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: report.slice(
                    index * 200_000,
                    (index + 1) * 200_000,
                  ),
                },
              },
            ],
          })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ]);
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "cowork",
            coworkStrategy: "direct",
          }),
        ),
      )
    ).text(),
  );
  const result = output.find(
    (item) => item.event === "result",
  ).data;
  assert.equal(result.status, "completed");
  assert.ok(result.html.length > 1_000_000);
});

test("retries malformed Cowork JSON once with an exact-format correction", async () => {
  const calls = [];
  const valid = JSON.stringify({
    status: "completed",
    html: "<!doctype html><html><body><h1>Corrected</h1></body></html>",
    summary: "Corrected output",
    updates: ["Changed heading"],
    issues: [],
    suggestions: [],
  });
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const delta =
      calls.length === 1
        ? '{"status":"completed","html":"<!doctype html><html>'
        : valid;
    return providerStream([
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta,
      })}\n\n`,
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  };
  const payload = body({
    mode: "cowork",
    config: { ...body().config, protocol: "openai-responses" },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls.length, 2);
  assert.ok(
    result.some(
      (item) =>
        item.event === "phase" && item.data.stage === "structured-retry",
    ),
  );
  assert.match(
    calls[1].input.at(-1).content[0].text,
    /CORRECTION: Return only complete valid JSON/,
  );
  assert.equal(
    result.find((item) => item.event === "result").data.summary,
    "Corrected output",
  );
});

test("rejects structurally complex Cowork model output", async () => {
  let calls = 0;
  const complex = `{"status":"blocked","summary":"Stop","padding":[${Array.from(
    { length: 20_000 },
    () => "{}",
  ).join(",")}],"updates":[],"issues":[],"suggestions":[]}`;
  globalThis.fetch = async () => {
    calls += 1;
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: complex } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "cowork",
            coworkStrategy: "direct",
          }),
        ),
      )
    ).text(),
  );
  assert.equal(calls, 2);
  assert.equal(
    output.some((item) => item.event === "result"),
    false,
  );
  assert.match(
    output.find((item) => item.event === "error").data.message,
    /JSON 结构过于复杂/,
  );
});

test("returns a bounded handoff card without keys or unsafe references", async () => {
  const apiKey = "sk-ant-supersecret12345";
  const card = JSON.stringify({
    title: "Landing handoff",
    objective: `Ship the page using ${apiKey}`,
    decisions: ["Keep the hero"],
    references: [
      { title: "Safe", url: "https://example.com/?token=secret", note: apiKey },
      { title: "Unsafe", url: "javascript:alert(1)" },
    ],
    constraints: ["No scripts"],
    openQuestions: ["Final copy?"],
    instruction: "Implement the approved layout",
    apiKey,
  });
  globalThis.fetch = async () =>
    providerStream([
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: card },
      })}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  const payload = body({
    mode: "handoff",
    config: {
      providerId: "custom",
      protocol: "anthropic",
      baseUrl: "https://models.example",
      model: "claude-test",
      apiKey,
    },
    history: [{ role: "assistant", content: "Prior decision" }],
  });
  const source = await (await POST(request(payload))).text();
  const cardResult = events(source).find((item) => item.event === "result").data;
  assert.equal(source.includes(apiKey), false);
  assert.deepEqual(cardResult.decisions, ["Keep the hero"]);
  assert.equal(cardResult.references[0].url, "https://example.com/");
  assert.equal(cardResult.references[1].url, undefined);
  assert.equal(cardResult.apiKey, undefined);
});

test("retries an invalid handoff schema once and reapplies sanitization", async () => {
  const calls = [];
  const apiKey = "sk-ant-corrective-secret";
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const card =
      calls.length === 1
        ? JSON.stringify({ title: "Incomplete", objective: "Missing fields" })
        : JSON.stringify({
            title: "Corrected handoff",
            objective: `Ship without ${apiKey}`,
            decisions: [],
            references: [],
            constraints: [],
            openQuestions: [],
            instruction: "Implement the approved page",
          });
    return providerStream([
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: card },
      })}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  };
  const payload = body({
    mode: "handoff",
    config: {
      providerId: "custom",
      protocol: "anthropic",
      baseUrl: "https://models.example",
      model: "claude-test",
      apiKey,
    },
  });
  const source = await (await POST(request(payload))).text();
  const result = events(source);
  assert.equal(calls.length, 2);
  assert.match(
    calls[1].messages.at(-1).content[0].text,
    /CORRECTION: Return only complete valid JSON/,
  );
  assert.equal(source.includes(apiKey), false);
  assert.equal(
    result.find((item) => item.event === "result").data.title,
    "Corrected handoff",
  );
});

test("retries once without native search when the provider rejects its tool", async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return Response.json(
        { error: { message: "web_search_preview tool is not supported" } },
        { status: 400 },
      );
    }
    return providerStream([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Fallback reply"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  };
  const payload = body({
    config: {
      providerId: "openai",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6",
      apiKey: "key",
    },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls.length, 2);
  assert.ok(calls[0].tools);
  assert.equal(calls[1].tools, undefined);
  const final = result.find((item) => item.event === "result").data;
  assert.equal(final.searchSupported, false);
  assert.match(final.searchReason, /拒绝/);
});

test("never reports searchUsed for an unsupported provider", async () => {
  globalThis.fetch = async () =>
    providerStream([
      'event: response.web_search_call.completed\ndata: {"type":"response.web_search_call.completed"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Local reply"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  const payload = body({
    config: {
      providerId: "copilot",
      protocol: "openai-responses",
      baseUrl: "https://models.example/v1",
      model: "gpt-5.5",
      apiKey: "",
    },
  });
  const result = events(await (await POST(request(payload))).text());
  const final = result.find((item) => item.event === "result").data;
  assert.equal(final.searchSupported, false);
  assert.equal(final.searchUsed, false);
  assert.deepEqual(final.citations, []);
});

test("falls back from a Responses websocket failure to one nonstream Chat response", async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const outgoing = JSON.parse(init.body);
    calls.push(outgoing);
    if (calls.length === 1) {
      return Response.json(
        { error: { message: "Failed to create responses websocket" } },
        { status: 400 },
      );
    }
    return Response.json({
      object: "response",
      output_text: "Fallback answer",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "Fallback answer",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/fallback?sig=secret&view=1",
                  title: "Fallback source",
                },
              ],
            },
          ],
        },
      ],
    });
  };
  const payload = body({
    config: {
      providerId: "copilot",
      protocol: "openai-responses",
      baseUrl: "https://models.example/v1",
      model: "gpt-5.5",
      apiKey: "",
    },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stream, true);
  assert.equal(calls[1].stream, undefined);
  assert.ok(
    result.some(
      (item) => item.event === "phase" && item.data.stage === "stream-fallback",
    ),
  );
  assert.deepEqual(
    result.filter((item) => item.event === "delta").map((item) => item.data.text),
    ["Fallback answer"],
  );
  const final = result.find((item) => item.event === "result").data;
  assert.equal(final.streamingSupported, false);
  assert.match(final.streamingReason, /responses websocket/);
  assert.equal(final.searchUsed, false);
  assert.equal(final.citations.length, 1);
  assert.equal(
    final.citations[0].url,
    "https://example.com/fallback?view=1",
  );
});

test("falls back from stream initialization failure while keeping Cowork buffered", async () => {
  const calls = [];
  const report = {
    status: "completed",
    html: "<!doctype html><html><body><h1>Fallback</h1></body></html>",
    summary: "Used standard response",
    updates: ["Changed heading"],
    issues: [],
    suggestions: [],
  };
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return providerStream([
        'event: error\ndata: {"type":"error","error":{"message":"Responses websocket stream error:"}}\n\n',
      ]);
    }
    return Response.json({
      object: "response",
      output_text: JSON.stringify(report),
    });
  };
  const payload = body({
    mode: "cowork",
    config: {
      ...body().config,
      protocol: "openai-responses",
    },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stream, true);
  assert.equal(calls[1].stream, undefined);
  assert.equal(result.some((item) => item.event === "delta"), false);
  assert.equal(
    result.find((item) => item.event === "result").data.summary,
    "Used standard response",
  );
});

test("attempts streaming fallback only once", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(
      { error: { message: "Failed to create responses websocket" } },
      { status: 400 },
    );
  };
  const payload = body({
    config: {
      providerId: "copilot",
      protocol: "openai-responses",
      baseUrl: "https://models.example/v1",
      model: "gpt-5.5",
      apiKey: "",
    },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls, 2);
  assert.ok(result.some((item) => item.event === "error"));
  assert.equal(
    result.filter(
      (item) => item.event === "phase" && item.data.stage === "stream-fallback",
    ).length,
    1,
  );
});

test("cancels a pending nonstream fallback response on disconnect", async () => {
  let calls = 0;
  let fallbackSignal;
  let fallbackCancelled = false;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { error: { message: "Failed to create responses websocket" } },
        { status: 400 },
      );
    }
    fallbackSignal = init.signal;
    return new Response(
      new ReadableStream({
        cancel() {
          fallbackCancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const abort = new AbortController();
  const payload = body({
    config: {
      providerId: "copilot",
      protocol: "openai-responses",
      baseUrl: "https://models.example/v1",
      model: "gpt-5.5",
      apiKey: "",
    },
  });
  const response = await POST(request(payload, abort.signal));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let source = "";
  while (!source.includes("stream-fallback")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    source += decoder.decode(chunk.value, { stream: true });
  }
  abort.abort("disconnected");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(fallbackSignal.aborted, true);
  assert.equal(fallbackCancelled, true);
  await reader.cancel();
});

test("does not retry valid structured Cowork output with unsafe HTML", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const unsafe = JSON.stringify({
      status: "completed",
      html: "<!doctype html><html><body></body></html>",
      summary: "Removed everything",
      updates: ["Cleared page"],
      issues: [],
      suggestions: [],
    });
    return providerStream([
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: unsafe,
      })}\n\n`,
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  };
  const payload = body({
    mode: "cowork",
    config: { ...body().config, protocol: "openai-responses" },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls, 1);
  assert.equal(
    result.some(
      (item) =>
        item.event === "phase" && item.data.stage === "structured-retry",
    ),
    false,
  );
  assert.match(
    result.find((item) => item.event === "error").data.message,
    /异常空白页面/,
  );
});

test("does not retry a valid blocked Cowork result", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const blocked = JSON.stringify({
      status: "blocked",
      summary: "A destination URL is required",
      updates: [],
      issues: ["Destination is missing"],
      suggestions: [],
    });
    return providerStream([
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: blocked,
      })}\n\n`,
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  };
  const payload = body({
    mode: "cowork",
    config: { ...body().config, protocol: "openai-responses" },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls, 1);
  assert.equal(result.find((item) => item.event === "result").data.status, "blocked");
  assert.equal(
    result.some(
      (item) =>
        item.event === "phase" && item.data.stage === "structured-retry",
    ),
    false,
  );
});

test("propagates abort and cancels the upstream reader", async () => {
  let upstreamSignal;
  let cancelled = false;
  globalThis.fetch = async (_url, init) => {
    upstreamSignal = init.signal;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const abort = new AbortController();
  const response = await POST(request(body(), abort.signal));
  const reader = response.body.getReader();
  await reader.read();
  abort.abort("disconnected");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(cancelled, true);
  await reader.cancel();
});

test("reports malformed provider streams and enforces security limits", async () => {
  globalThis.fetch = async () => providerStream(["data: {not-json}\n\n"]);
  const malformed = events(await (await POST(request(body()))).text());
  const error = malformed.find((item) => item.event === "error").data;
  assert.match(error.message, /格式错误/);
  assert.equal(typeof error.retryable, "boolean");

  const oversized = await POST(
    request(body({ instruction: "x".repeat(12_001) })),
  );
  assert.equal(oversized.status, 400);
  assert.equal(events(await oversized.text())[0].data.code, "invalid_request");

  const oversizedHtml = await POST(
    request(
      body({
        html: `<!doctype html><html><body>${"x".repeat(
          5 * 1024 * 1024 + 1,
        )}</body></html>`,
      }),
    ),
  );
  assert.equal(oversizedHtml.status, 400);
  assert.match(
    events(await oversizedHtml.text())[0].data.message,
    /5,242,880/,
  );

  const declared = await POST(
    request(body(), undefined, { "content-length": "16777217" }),
  );
  assert.equal(declared.status, 413);
});

test("retries Cowork when the provider connection closes mid-stream", async () => {
  let calls = 0;
  const report = JSON.stringify({
    status: "completed",
    html: "<!doctype html><html><body><h1>Retried</h1></body></html>",
    summary: "Retried safely",
    updates: ["Changed heading"],
    issues: [],
    suggestions: [],
  });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"status\\":\\"completed\\""}\n\n',
              ),
            );
            const error = new Error("socket closed");
            error.cause = { code: "ECONNRESET" };
            controller.error(error);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return providerStream([
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: report,
      })}\n\n`,
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  };
  const payload = body({
    mode: "cowork",
    config: { ...body().config, protocol: "openai-responses" },
  });
  const result = events(await (await POST(request(payload))).text());
  assert.equal(calls, 2);
  assert.equal(result.find((item) => item.event === "result").data.status, "completed");
  assert.equal(result.some((item) => item.event === "delta"), false);
});

test("bounds native multi-turn history to the most recent 20 messages", async () => {
  let outgoing;
  globalThis.fetch = async (_url, init) => {
    outgoing = JSON.parse(init.body);
    return providerStream([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  const history = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `turn-${index}`,
  }));
  await (await POST(request(body({ history })))).text();
  const serialized = JSON.stringify(outgoing.messages);
  assert.equal(serialized.includes("turn-0"), false);
  assert.equal(serialized.includes("turn-10"), true);
  assert.ok(outgoing.messages.length <= 22);
});

test("Auto routes one unified conversation to Chat", async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const text =
      call === 1
        ? JSON.stringify({
            action: "chat",
            summary: "Answer without editing.",
          })
        : "A concise advisory answer.";
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const response = await POST(
    request(
      body({
        mode: "auto",
        instruction: "What should this page improve?",
      }),
    ),
  );
  const output = events(await response.text());
  assert.equal(
    output.find((item) => item.event === "decision").data.action,
    "chat",
  );
  assert.equal(
    output.find((item) => item.event === "result").data.reply,
    "A concise advisory answer.",
  );
  assert.equal(call, 2);
});

test("Plan returns a structured mission plan without HTML", async () => {
  const plan = JSON.stringify({
    strategy: "mission",
    objective: "Improve hierarchy",
    summary: "A two-step plan",
    assumptions: [],
    steps: [
      {
        id: "step-1",
        title: "Audit",
        description: "Review the hierarchy",
      },
      {
        id: "step-2",
        title: "Refine",
        description: "Strengthen the primary action",
      },
    ],
    acceptanceCriteria: ["One clear primary action"],
    openQuestions: [],
  });
  globalThis.fetch = async () =>
    providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: plan } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  const output = events(
    await (
      await POST(request(body({ mode: "plan" })))
    ).text(),
  );
  const result = output.find((item) => item.event === "result").data;
  assert.equal(result.mode, "plan");
  assert.equal(result.plan.strategy, "mission");
  assert.equal(result.html, undefined);
});

test("Auto routes execution through Cowork validation", async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const text =
      call === 1
        ? JSON.stringify({
            action: "agent",
            summary: "Execute the requested edit.",
          })
        : JSON.stringify({
            status: "completed",
            html: "<!doctype html><html><body><h1>Auto Agent</h1></body></html>",
            summary: "Updated heading",
            updates: ["Changed heading"],
            issues: [],
            suggestions: [],
          });
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "auto",
            instruction: "Change the heading to Auto Agent.",
          }),
        ),
      )
    ).text(),
  );
  const result = output.find((item) => item.event === "result").data;
  assert.equal(result.action, "agent");
  assert.match(result.html, /Auto Agent/);
  assert.equal(call, 2);
});

test("Auto router receives bounded unified conversation history", async () => {
  let routerBody;
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    call += 1;
    routerBody ??= JSON.parse(init.body);
    const text =
      call === 1
        ? JSON.stringify({
            action: "chat",
            summary: "Continue the discussion.",
          })
        : "Follow-up answer";
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  await (
    await POST(
      request(
        body({
          mode: "auto",
          instruction: "Do that next.",
          history: [
            { role: "user", text: "Discuss the hero hierarchy." },
            {
              role: "assistant",
              text: "Use one primary headline and action.",
            },
          ],
        }),
      ),
    )
  ).text();
  assert.match(
    JSON.stringify(routerBody),
    /Discuss the hero hierarchy/,
  );
  assert.match(
    JSON.stringify(routerBody),
    /Use one primary headline and action/,
  );
});

test("Auto uses deterministic fallback after two malformed router responses", async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const text =
      call <= 2
        ? "not-json"
        : JSON.stringify({
            status: "completed",
            html: "<!doctype html><html><body><h1>Fallback Agent</h1></body></html>",
            summary: "Updated heading",
            updates: ["Changed heading"],
            issues: [],
            suggestions: [],
          });
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "auto",
            instruction: "Change the heading to Fallback Agent.",
          }),
        ),
      )
    ).text(),
  );
  assert.equal(
    output.find((item) => item.event === "decision").data.action,
    "agent",
  );
  assert.match(
    output.find((item) => item.event === "result").data.html,
    /Fallback Agent/,
  );
  assert.equal(call, 3);
});

test("Auto fallback keeps idea requests non-mutating", async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const text =
      call <= 2 ? "not-json" : "Try a benefit-led headline and a product demo.";
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "auto",
            instruction: "Give me two ideas for the hero section.",
          }),
        ),
      )
    ).text(),
  );
  assert.equal(
    output.find((item) => item.event === "decision").data.action,
    "chat",
  );
  assert.equal(
    output.find((item) => item.event === "result").data.reply,
    "Try a benefit-led headline and a product demo.",
  );
  assert.equal(
    output.some(
      (item) =>
        item.event === "result" &&
        typeof item.data.html === "string",
    ),
    false,
  );
});

test("Auto fallback respects negated edit requests", async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const text =
      call <= 2 ? "not-json" : "The page has a headline and one call to action.";
    return providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "auto",
            instruction:
              "Do not change the HTML; summarize the page.",
          }),
        ),
      )
    ).text(),
  );
  assert.equal(
    output.find((item) => item.event === "decision").data.action,
    "chat",
  );
  assert.equal(
    output.find((item) => item.event === "result").data.reply,
    "The page has a headline and one call to action.",
  );
});

test("provider done event terminates an otherwise open SSE connection", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"Done now"}}]}\n\ndata: [DONE]\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const source = await Promise.race([
    POST(request(body())).then((response) => response.text()),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("provider completion was not terminal")),
        1_000,
      ),
    ),
  ]);
  assert.match(source, /Done now/);
  assert.equal(cancelled, true);
});

test("preserves terminal completion when the final event contains citations", async () => {
  globalThis.fetch = async () =>
    providerStream([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Answer"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","annotations":[{"type":"url_citation","url":"https://example.com/source","title":"Source"}]}\n\n',
    ]);
  const output = events(
    await (
      await POST(
        request(
          body({
            config: {
              ...body().config,
              protocol: "openai-responses",
            },
          }),
        ),
      )
    ).text(),
  );
  assert.equal(
    output.find((item) => item.event === "result").data.reply,
    "Answer",
  );
  assert.equal(
    output.find((item) => item.event === "citation").data.url,
    "https://example.com/source",
  );
  assert.deepEqual(output.at(-1), {
    event: "done",
    data: { stopped: false },
  });
});

test("SSE parser rejects cumulative multiline event overflow", () => {
  const parser = new sseModule.SSEChunkParser();
  const line = `data: ${"x".repeat(20_000)}\n`;
  assert.throws(
    () => {
      for (let index = 0; index < 700; index += 1) {
        parser.push(line);
      }
    },
    /事件过大/,
  );
});

test("redacts API keys echoed by upstream errors", async () => {
  const apiKey = "sk-secret-canary-123456789";
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          message: `Authorization failed for Bearer ${apiKey}`,
        },
      },
      { status: 401 },
    );
  const source = await (
    await POST(
      request(
        body({
          config: {
            ...body().config,
            apiKey,
          },
        }),
      ),
    )
  ).text();
  assert.equal(source.includes(apiKey), false);
  assert.match(source, /Authorization failed/);
});

test("rejects a complete-looking Cowork JSON stream without terminal event", async () => {
  const report = JSON.stringify({
    status: "completed",
    html: "<!doctype html><html><body><h1>Must not apply</h1></body></html>",
    summary: "Truncated response",
    updates: ["Changed heading"],
    issues: [],
    suggestions: [],
  });
  globalThis.fetch = async () =>
    providerStream([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: report } }],
      })}\n\n`,
    ]);
  const output = events(
    await (
      await POST(
        request(
          body({
            mode: "agent",
          }),
        ),
      )
    ).text(),
  );
  assert.equal(
    output.some((item) => item.event === "result"),
    false,
  );
  assert.match(
    output.find((item) => item.event === "error").data.message,
    /完成事件前中断/,
  );
});

test("rejects a truncated Chat stream without marking it complete", async () => {
  globalThis.fetch = async () =>
    providerStream([
      'data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n',
    ]);
  const output = events(
    await (await POST(request(body()))).text(),
  );
  assert.equal(
    output.some((item) => item.event === "result"),
    false,
  );
  assert.match(
    output.find((item) => item.event === "error").data.message,
    /完成事件前中断/,
  );
});

test("cancels malformed upstream streams", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":\n\n'),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const output = events(
    await (await POST(request(body()))).text(),
  );
  assert.equal(cancelled, true);
  assert.match(
    output.find((item) => item.event === "error").data.message,
    /格式错误的流事件/,
  );
});

test("bounds and cancels oversized provider error bodies", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `{"error":{"message":"${"x".repeat(50_000)}`,
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  const output = events(
    await (await POST(request(body()))).text(),
  );
  assert.equal(cancelled, true);
  const message =
    output.find((item) => item.event === "error").data.message;
  assert.match(message, /模型请求失败/);
  assert.ok(message.length < 2_000);
});

test("rejects structurally complex nonstream provider envelopes", async () => {
  globalThis.fetch = async () =>
    new Response(
      `{"output_text":"ok","padding":[${Array.from(
        { length: 20_000 },
        () => "{}",
      ).join(",")}]}`,
      { headers: { "content-type": "application/json" } },
    );
  const output = events(
    await (await POST(request(body()))).text(),
  );
  assert.equal(
    output.some((item) => item.event === "result"),
    false,
  );
  assert.match(
    output.find((item) => item.event === "error").data.message,
    /JSON 结构过于复杂/,
  );
});

test("rejects chunked request bodies above 16 megabytes", async () => {
  const chunk = new Uint8Array(9 * 1024 * 1024);
  const response = await POST(
    new Request("https://canvasly.example/api/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    }),
  );
  assert.equal(response.status, 413);
  const output = events(await response.text());
  assert.equal(
    output.find((item) => item.event === "error").data.code,
    "request_too_large",
  );
});

test("rejects structurally complex JSON before provider execution", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return providerStream(["data: [DONE]\n\n"]);
  };
  const response = await POST(
    new Request("https://canvasly.example/api/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"mode":"chat","padding":[${Array.from(
        { length: 20_000 },
        () => "{}",
      ).join(",")}]}`,
    }),
  );
  assert.equal(response.status, 400);
  assert.match(
    events(await response.text())[0].data.message,
    /结构过于复杂/,
  );
  assert.equal(calls, 0);
});

test("does not contact the provider when the request was already aborted", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return providerStream(["data: [DONE]\n\n"]);
  };
  const controller = new AbortController();
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  const response = await POST(
    request(body(), controller.signal),
  );
  await response.text();
  assert.equal(calls, 0);
});
