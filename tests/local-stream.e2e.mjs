import assert from "node:assert/strict";
import test from "node:test";
import { readCanvaslyEventStream } from "../app/stream-client.ts";

const canvaslyUrl =
  process.env.CANVASLY_E2E_URL || "http://127.0.0.1:4173";
const endpoint =
  process.env.CANVASLY_MODEL_ENDPOINT ||
  "http://host.docker.internal:4141/v1";
const model = process.env.CANVASLY_MODEL || "gpt-5.5";

const config = {
  providerId: "copilot",
  protocol: "openai-responses",
  baseUrl: endpoint,
  model,
  apiKey: "",
};

const html =
  "<!doctype html><html><body><main><h1>Streaming workspace</h1><p id=\"stable\">Keep this paragraph.</p></main></body></html>";

async function stream(body, { signal } = {}) {
  const controller = signal ? null : new AbortController();
  const response = await fetch(`${canvaslyUrl}/api/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config,
      html,
      selection: null,
      attachments: [],
      history: [],
      ...body,
    }),
    signal: signal ?? controller.signal,
  });
  const events = [];
  await readCanvaslyEventStream(response, {
    onEvent: (event) => events.push(event),
  });
  const failure = events.find((event) => event.type === "error");
  if (failure) throw new Error(failure.message);
  return events;
}

function result(events) {
  return events.find((event) => event.type === "result")?.result;
}

test("local gpt-5.5 streaming collaboration", {
  timeout: 1_800_000,
}, async (suite) => {
  await suite.test("Auto routes a question to a streamed answer", async () => {
    const events = await stream({
      mode: "auto",
      instruction:
        "What are two concise visual hierarchy suggestions? Do not modify HTML.",
    });
    const deltas = events.filter((event) => event.type === "delta");
    assert.ok(deltas.length > 0);
    const payload = result(events);
    assert.equal(typeof payload.reply, "string");
    assert.ok(payload.reply.length > 20);
    assert.equal(payload.action, "chat");
    assert.equal(payload.searchSupported, false);
  });

  await suite.test("Agent streams phases and atomically returns valid HTML", async () => {
    const events = await stream({
      mode: "agent",
      instruction:
        "Change only the h1 to Streamed execution. Preserve #stable exactly.",
    });
    const phases = events
      .filter((event) => event.type === "phase")
      .map((event) => event.phase.stage);
    assert.ok(phases.includes("connecting"));
    assert.ok(phases.includes("generating"));
    assert.ok(phases.includes("validating"));
    assert.equal(events.some((event) => event.type === "delta"), false);
    const payload = result(events);
    assert.equal(payload.status, "completed");
    assert.equal(payload.action, "agent");
    assert.match(payload.html, /<h1>\s*Streamed execution\s*<\/h1>/i);
    assert.match(payload.html, /id=["']stable["']>\s*Keep this paragraph\./i);
  });

  await suite.test("one conversation can discuss and then execute with history", async () => {
    const chatEvents = await stream({
      mode: "auto",
      instruction:
        "Who could this page serve? Answer briefly and do not edit it.",
    });
    assert.ok(
      chatEvents.some(
        (event) => event.type === "delta" && event.text.length > 0,
      ),
    );
    const coworkEvents = await stream({
      mode: "agent",
      instruction:
        "Apply the discussed direction by changing only the h1 to Research team workspace. Preserve #stable.",
      history: [
        {
          role: "user",
          text: "Who could this page serve?",
        },
        {
          role: "assistant",
          text: result(chatEvents).reply,
        },
      ],
    });
    assert.match(
      result(coworkEvents).html,
      /<h1>\s*Research team workspace\s*<\/h1>/i,
    );
  });

  await suite.test("Plan creates a bounded structured plan without HTML", async () => {
    const events = await stream({
      mode: "plan",
      instruction: "整理当前讨论为一个页面改进计划。",
      history: [
        {
          role: "user",
          text: "We should make the hero clearer for research teams.",
        },
        {
          role: "assistant",
          text: "Keep the current paragraph and focus the heading on shared research.",
        },
      ],
    });
    const payload = result(events);
    assert.equal(payload.mode, "plan");
    assert.equal(payload.action, "plan");
    assert.equal(payload.plan.strategy, "mission");
    assert.ok(payload.plan.steps.length > 0);
    assert.equal(payload.html, undefined);
  });

  await suite.test("plans and executes a high-level Cowork mission", async () => {
    const events = await stream({
      mode: "agent",
      coworkStrategy: "mission",
      instruction:
        "Redesign the whole page to feel more professional for research teams, improve hierarchy and conversion, while preserving the stable paragraph.",
    });
    const planEvent = events.find((event) => event.type === "plan");
    assert.ok(planEvent);
    assert.equal(planEvent.plan.strategy, "mission");
    assert.ok(planEvent.plan.steps.length >= 2);
    assert.ok(planEvent.plan.acceptanceCriteria.length > 0);
    const payload = result(events);
    assert.equal(payload.status, "completed");
    assert.equal(payload.strategy, "mission");
    assert.ok(payload.plan.steps.length >= 2);
    assert.match(payload.html, /id=["']stable["']/i);
  });

  await suite.test("aborts an in-flight Chat stream without affecting the server", async () => {
    const controller = new AbortController();
    const response = await fetch(`${canvaslyUrl}/api/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "auto",
        config,
        html,
        instruction:
          "Give a detailed ten-part critique of this page with examples.",
        selection: null,
        attachments: [],
        history: [],
      }),
      signal: controller.signal,
    });
    let received = "";
    try {
      await readCanvaslyEventStream(response, {
        onEvent(event) {
          if (event.type !== "delta") return;
          received += event.text;
          controller.abort();
        },
      });
    } catch (error) {
      assert.match(String(error), /abort/i);
    }
    assert.equal(controller.signal.aborted, true);
    assert.ok(received.length > 0);
    const health = await fetch(canvaslyUrl);
    assert.equal(health.ok, true);
  });
});
