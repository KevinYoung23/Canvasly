import assert from "node:assert/strict";
import test from "node:test";
import { readCanvaslyEventStream } from "../app/stream-client.ts";
import { fallbackUnifiedAction } from "../app/intent-routing.ts";

function chunkedResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

test("uses conservative shared fallback routing", () => {
  assert.equal(
    fallbackUnifiedAction("Give me two ideas for the hero section."),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction(
      "Do not change the HTML; summarize the page.",
    ),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction("请勿修改页面。"),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction("Avoid changing the page."),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction(
      "Please refrain from editing the page.",
    ),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction("Make no changes to the page."),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction(
      "Make sure not to change the page.",
    ),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction("不修改页面。"),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction("请对页面不作任何修改。"),
    "chat",
  );
  assert.equal(
    fallbackUnifiedAction("Change the hero headline."),
    "agent",
  );
  assert.equal(
    fallbackUnifiedAction("请帮我修改页面标题。"),
    "agent",
  );
  assert.equal(
    fallbackUnifiedAction("让主标题更醒目。"),
    "agent",
  );
  assert.equal(
    fallbackUnifiedAction("Plan a new pricing section."),
    "plan",
  );
});

test("parses Canvasly SSE across arbitrary chunk boundaries", async () => {
  const events = [];
  await readCanvaslyEventStream(
    chunkedResponse([
      'event: phase\ndata: {"stage":"preparing","message":"准备',
      '上下文"}\n\nevent: decision\ndata: {"action":"agent","summary":"Execute the requested change"}\n\nevent: delta\ndata: {"text":"你',
      '好"}\n\nevent: plan\ndata: {"strategy":"mission","objective":"Improve","summary":"Plan","assumptions":[],"steps":[{"id":"step-1","title":"Audit","description":"Review"}],"acceptanceCriteria":["Visible"],"openQuestions":[]}\n\nevent: citation\ndata: {"id":"source-1","title":"Source","url":"https://example.com"}\n\n',
      'event: result\ndata: {"result":{"reply":"你好"}}\n\nevent: done\ndata: {"stopped":false}\n\n',
    ]),
    { onEvent: (event) => events.push(event) },
  );

  assert.deepEqual(events, [
    {
      type: "phase",
      phase: { stage: "preparing", message: "准备上下文" },
    },
    {
      type: "decision",
      decision: {
        action: "agent",
        summary: "Execute the requested change",
      },
    },
    { type: "delta", text: "你好" },
    {
      type: "plan",
      plan: {
        strategy: "mission",
        objective: "Improve",
        summary: "Plan",
        assumptions: [],
        steps: [
          {
            id: "step-1",
            title: "Audit",
            description: "Review",
          },
        ],
        acceptanceCriteria: ["Visible"],
        openQuestions: [],
      },
    },
    {
      type: "citation",
      citation: {
        id: "source-1",
        title: "Source",
        url: "https://example.com",
        snippet: undefined,
      },
    },
    { type: "result", result: { reply: "你好" } },
    { type: "done", stopped: false },
  ]);
});

test("surfaces non-success stream responses", async () => {
  await assert.rejects(
    () =>
      readCanvaslyEventStream(
        new Response(JSON.stringify({ error: "stream unavailable" }), {
          status: 503,
        }),
        { onEvent: () => undefined },
      ),
    /stream unavailable/,
  );
});

test("extracts route errors from non-success SSE responses", async () => {
  await assert.rejects(
    () =>
      readCanvaslyEventStream(
        new Response(
          'event: error\ndata: {"code":"invalid_request","message":"Missing model configuration","retryable":false}\n\nevent: done\ndata: {"stopped":false}\n\n',
          {
            status: 400,
            headers: { "content-type": "text/event-stream" },
          },
        ),
        { onEvent: () => undefined },
      ),
    /^Error: Missing model configuration$/,
  );
});

test("rejects a stream that closes before done", async () => {
  await assert.rejects(
    () =>
      readCanvaslyEventStream(
        chunkedResponse([
          'event: phase\ndata: {"stage":"working","message":"Still working"}\n\n',
        ]),
        { onEvent: () => undefined },
      ),
    /完成前中断/,
  );
});
