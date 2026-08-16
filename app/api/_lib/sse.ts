import { MAX_PROVIDER_EVENT_LENGTH } from "./limits";
import { parseJsonBounded } from "./request-body";

export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat"
  | "anthropic";

export type ParsedSSEEvent = {
  event: string;
  data: string;
};

export type SafeCitation = {
  id: string;
  title: string;
  url: string;
  snippet: string;
};

export type ProviderStreamItem =
  | { type: "delta"; text: string }
  | { type: "citation"; citation: SafeCitation }
  | { type: "done" }
  | { type: "error"; message: string };

export class SSEChunkParser {
  private buffer = "";
  private eventName = "message";
  private dataLines: string[] = [];
  private dataLength = 0;

  push(chunk: string): ParsedSSEEvent[] {
    this.buffer += chunk;
    const events: ParsedSSEEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, events);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_PROVIDER_EVENT_LENGTH) {
      throw new Error("模型流事件过大");
    }
    return events;
  }

  finish(): ParsedSSEEvent[] {
    const events: ParsedSSEEvent[] = [];
    if (this.buffer) this.consumeLine(this.buffer.replace(/\r$/, ""), events);
    this.buffer = "";
    this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: ParsedSSEEvent[]) {
    if (!line) {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value || "message";
    if (field === "data") {
      this.dataLength += value.length + (this.dataLines.length ? 1 : 0);
      if (this.dataLength > MAX_PROVIDER_EVENT_LENGTH) {
        throw new Error("模型流事件过大");
      }
      this.dataLines.push(value);
    }
  }

  private dispatch(events: ParsedSSEEvent[]) {
    if (this.dataLines.length) {
      events.push({
        event: this.eventName,
        data: this.dataLines.join("\n"),
      });
    }
    this.eventName = "message";
    this.dataLines = [];
    this.dataLength = 0;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeCitation(
  value: unknown,
  fallbackId: string,
): SafeCitation | null {
  const outer = record(value);
  const source =
    record(outer?.url_citation) ??
    record(outer?.citation) ??
    outer;
  const rawUrl = text(
    source?.url ?? source?.uri ?? source?.href ?? source?.source_url,
    4_096,
  );
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return null;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase().replace(/[-_.]/g, "");
    if (
      /^(?:key|auth|sig)$|(?:apikey|apitoken|authtoken|accesstoken|accesskey|authkey|clientsecret|credential|password|passwd|privatekey|secret|signature|token)/.test(
        normalized,
      )
    ) {
      url.searchParams.delete(key);
    }
  }
  const title =
    text(source?.title ?? source?.name, 240) || url.hostname.slice(0, 240);
  const snippet = text(
    source?.snippet ??
      source?.cited_text ??
      source?.excerpt ??
      source?.description ??
      source?.content,
    800,
  );
  return {
    id: text(source?.id, 80) || fallbackId,
    title,
    url: url.toString(),
    snippet,
  };
}

function citationItems(
  value: unknown,
  startIndex: number,
): SafeCitation[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((item, index) => {
    const citation = normalizeCitation(item, `citation-${startIndex + index}`);
    return citation ? [citation] : [];
  });
}

function responseCitations(root: Record<string, unknown>, startIndex: number) {
  const direct = citationItems(
    root.annotation ?? root.annotations ?? root.citation ?? root.citations,
    startIndex,
  );
  const response = record(root.response);
  const output = Array.isArray(response?.output)
    ? response.output
    : Array.isArray(root.output)
      ? root.output
      : [];
  const nested = output.flatMap((item) => {
    const content = record(item)?.content;
    return (Array.isArray(content) ? content : []).flatMap((part) => {
      const annotations = record(part)?.annotations;
      return Array.isArray(annotations) ? annotations : [];
    });
  });
  return [...direct, ...citationItems(nested, startIndex + direct.length)];
}

export function providerPayloadCitations(
  protocol: ProviderProtocol,
  payload: unknown,
  startIndex = 1,
) {
  const root = record(payload);
  if (!root) return [];
  if (protocol === "openai-responses") {
    return responseCitations(root, startIndex);
  }
  if (protocol === "openai-chat") {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const annotations = choices.flatMap((choice) => {
      const choiceRecord = record(choice);
      const message = record(choiceRecord?.message);
      const content = Array.isArray(message?.content)
        ? message.content
        : [];
      return [
        ...(Array.isArray(message?.annotations)
          ? message.annotations
          : []),
        ...(Array.isArray(message?.citations)
          ? message.citations
          : []),
        ...content.flatMap((part) => {
          const partRecord = record(part);
          return Array.isArray(partRecord?.annotations)
            ? partRecord.annotations
            : [];
        }),
      ];
    });
    return citationItems(annotations, startIndex);
  }
  const content = Array.isArray(root.content) ? root.content : [];
  const citations = content.flatMap((block) => {
    const blockRecord = record(block);
    return [
      ...(Array.isArray(blockRecord?.citations)
        ? blockRecord.citations
        : []),
      ...(blockRecord?.citation ? [blockRecord.citation] : []),
    ];
  });
  return citationItems(citations, startIndex);
}

export function translateProviderEvent(
  protocol: ProviderProtocol,
  event: ParsedSSEEvent,
  citationStartIndex = 1,
): ProviderStreamItem[] {
  if (event.data === "[DONE]") return [{ type: "done" }];
  let payload: unknown;
  try {
    payload = parseJsonBounded(event.data);
  } catch {
    throw new Error("模型返回了格式错误的流事件");
  }
  const root = record(payload);
  if (!root) throw new Error("模型返回了格式错误的流事件");
  const eventType = text(root.type, 120) || event.event;

  if (eventType === "error") {
    const error = record(root.error);
    return [
      {
        type: "error",
        message:
          text(error?.message ?? root.message, 1_000) || "模型流返回错误",
      },
    ];
  }

  if (protocol === "openai-responses") {
    if (eventType === "response.output_text.delta") {
      return typeof root.delta === "string"
        ? [{ type: "delta", text: root.delta }]
        : [];
    }
    const citations = responseCitations(root, citationStartIndex).map(
      (citation): ProviderStreamItem => ({ type: "citation", citation }),
    );
    if (
      eventType === "response.completed" ||
      eventType === "response.incomplete"
    ) {
      return [...citations, { type: "done" }];
    }
    return citations;
  }

  if (protocol === "openai-chat") {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = record(choices[0]);
    const delta = record(first?.delta);
    const result: ProviderStreamItem[] = [];
    if (typeof delta?.content === "string" && delta.content) {
      result.push({ type: "delta", text: delta.content });
    }
    const annotations =
      delta?.annotations ?? delta?.citations ?? first?.annotations;
    result.push(
      ...citationItems(annotations, citationStartIndex).map(
        (citation): ProviderStreamItem => ({ type: "citation", citation }),
      ),
    );
    if (first?.finish_reason) result.push({ type: "done" });
    return result;
  }

  if (eventType === "content_block_delta") {
    const delta = record(root.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "delta", text: delta.text }];
    }
    if (delta?.type === "citations_delta") {
      return citationItems(delta.citation, citationStartIndex).map(
        (citation): ProviderStreamItem => ({ type: "citation", citation }),
      );
    }
  }
  if (eventType === "message_stop") return [{ type: "done" }];
  return [];
}

export function encodeSSE(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
