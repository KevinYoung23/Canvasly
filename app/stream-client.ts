export type StreamCitation = {
  id: string;
  title: string;
  url: string;
  snippet?: string;
};

export type StreamPhase = {
  stage: string;
  message: string;
};

export type HandoffReference = {
  title: string;
  url?: string;
  note: string;
};

export type HandoffCard = {
  id: string;
  title: string;
  objective: string;
  decisions: string[];
  references: HandoffReference[];
  constraints: string[];
  openQuestions: string[];
  instruction: string;
  sourceMessageIds: string[];
  createdAt: string;
};

export type CoworkStrategy = "auto" | "direct" | "mission";

export type CoworkPlan = {
  strategy: "mission";
  objective: string;
  summary: string;
  assumptions: string[];
  steps: Array<{
    id: string;
    title: string;
    description: string;
  }>;
  acceptanceCriteria: string[];
  openQuestions: string[];
};

export type UnifiedDecision = {
  action: "chat" | "plan" | "agent";
  summary: string;
};

export type CanvaslyStreamEvent =
  | { type: "phase"; phase: StreamPhase }
  | { type: "decision"; decision: UnifiedDecision }
  | { type: "plan"; plan: CoworkPlan }
  | { type: "delta"; text: string }
  | { type: "citation"; citation: StreamCitation }
  | { type: "result"; result: unknown }
  | {
      type: "error";
      code?: string;
      message: string;
      retryable?: boolean;
    }
  | { type: "done"; stopped?: boolean };

type SseHandlers = {
  onEvent(event: CanvaslyStreamEvent): void;
};

function parseData(
  eventName: string,
  data: string,
): CanvaslyStreamEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    if (eventName === "delta") return { type: "delta", text: data };
    return null;
  }
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const type =
    eventName === "message" && typeof record.type === "string"
      ? record.type
      : eventName;

  if (type === "phase") {
    const phaseRecord =
      record.phase && typeof record.phase === "object"
        ? (record.phase as Record<string, unknown>)
        : record;
    return {
      type: "phase",
      phase: {
        stage:
          typeof phaseRecord.stage === "string"
            ? phaseRecord.stage
            : "working",
        message:
          typeof phaseRecord.message === "string"
            ? phaseRecord.message
            : "正在处理…",
      },
    };
  }
  if (type === "decision") {
    const decisionRecord =
      record.decision && typeof record.decision === "object"
        ? (record.decision as Record<string, unknown>)
        : record;
    if (
      (decisionRecord.action === "chat" ||
        decisionRecord.action === "plan" ||
        decisionRecord.action === "agent") &&
      typeof decisionRecord.summary === "string"
    ) {
      return {
        type: "decision",
        decision: {
          action: decisionRecord.action,
          summary: decisionRecord.summary,
        },
      };
    }
  }
  if (type === "plan") {
    const planRecord =
      record.plan && typeof record.plan === "object"
        ? (record.plan as Record<string, unknown>)
        : record;
    return {
      type: "plan",
      plan: planRecord as unknown as CoworkPlan,
    };
  }
  if (type === "delta" && typeof record.text === "string") {
    return { type: "delta", text: record.text };
  }
  if (type === "citation") {
    const citationRecord =
      record.citation && typeof record.citation === "object"
        ? (record.citation as Record<string, unknown>)
        : record;
    if (
      typeof citationRecord.id === "string" &&
      typeof citationRecord.title === "string" &&
      typeof citationRecord.url === "string"
    ) {
      return {
        type: "citation",
        citation: {
          id: citationRecord.id,
          title: citationRecord.title,
          url: citationRecord.url,
          snippet:
            typeof citationRecord.snippet === "string"
              ? citationRecord.snippet
              : undefined,
        },
      };
    }
  }
  if (type === "result") {
    return {
      type: "result",
      result: "result" in record ? record.result : record,
    };
  }
  if (type === "error") {
    return {
      type: "error",
      code: typeof record.code === "string" ? record.code : undefined,
      message:
        typeof record.message === "string"
          ? record.message
          : "流式请求失败",
      retryable:
        typeof record.retryable === "boolean"
          ? record.retryable
          : undefined,
    };
  }
  if (type === "done") {
    return {
      type: "done",
      stopped:
        typeof record.stopped === "boolean"
          ? record.stopped
          : undefined,
    };
  }
  return null;
}

function parseSseBlock(block: string) {
  let eventName = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0
        ? ""
        : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value || "message";
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return parseData(eventName, data.join("\n"));
}

export async function readCanvaslyEventStream(
  response: Response,
  handlers: SseHandlers,
) {
  if (!response.ok) {
    const source = await response.text();
    let message = source || `HTTP ${response.status}`;
    if (
      response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("text/event-stream")
    ) {
      const errorEvent = source
        .split(/\r?\n\r?\n/)
        .map(parseSseBlock)
        .find((event) => event?.type === "error");
      if (errorEvent?.type === "error") {
        throw new Error(errorEvent.message);
      }
    }
    try {
      const payload = JSON.parse(source) as { error?: string };
      message = payload.error || message;
    } catch {
      // Preserve the server response text when it is not JSON.
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("模型没有返回流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEventReceived = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) {
          if (event.type === "done") terminalEventReceived = true;
          handlers.onEvent(event);
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) {
        if (event.type === "done") terminalEventReceived = true;
        handlers.onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!terminalEventReceived) {
    throw new Error("模型流在完成前中断");
  }
}

export async function postCanvaslyStream(
  body: unknown,
  handlers: SseHandlers,
  signal: AbortSignal,
) {
  const response = await fetch("/api/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await readCanvaslyEventStream(response, handlers);
}
