export class RequestBodyTooLargeError extends Error {}
export class ResponseBodyTooLargeError extends Error {}
export class JsonStructureTooComplexError extends Error {}

const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRUCTURAL_TOKENS = 50_000;

type JsonStructureState = {
  depth: number;
  structuralTokens: number;
  inString: boolean;
  escaped: boolean;
};

function scanJsonStructure(
  chunk: string,
  state: JsonStructureState,
) {
  for (const character of chunk) {
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (character === "\\") {
        state.escaped = true;
      } else if (character === '"') {
        state.inString = false;
      }
      continue;
    }
    if (character === '"') {
      state.inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      state.depth += 1;
      state.structuralTokens += 1;
      if (state.depth > MAX_JSON_DEPTH) {
        throw new JsonStructureTooComplexError(
          "JSON 嵌套层级过深",
        );
      }
    } else if (character === "}" || character === "]") {
      state.depth -= 1;
      state.structuralTokens += 1;
    } else if (character === "," || character === ":") {
      state.structuralTokens += 1;
    }
    if (state.structuralTokens > MAX_JSON_STRUCTURAL_TOKENS) {
      throw new JsonStructureTooComplexError(
        "JSON 结构过于复杂",
      );
    }
  }
}

export function createJsonStructureScanner() {
  const state: JsonStructureState = {
    depth: 0,
    structuralTokens: 0,
    inString: false,
    escaped: false,
  };
  return {
    push(chunk: string) {
      scanJsonStructure(chunk, state);
    },
  };
}

export function assertJsonStructureBounded(source: string) {
  createJsonStructureScanner().push(source);
}

export function parseJsonBounded(source: string): unknown {
  assertJsonStructureBounded(source);
  return JSON.parse(source);
}

export async function readRequestTextBounded(
  request: Request,
  maxBytes: number,
) {
  const declaredLength = Number(
    request.headers.get("content-length") || "0",
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    throw new RequestBodyTooLargeError("请求内容过大");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let bytesRead = 0;
  let completed = false;
  const structure = createJsonStructureScanner();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        structure.push(tail);
        completed = true;
        return raw + tail;
      }
      if (value.byteLength > maxBytes - bytesRead) {
        throw new RequestBodyTooLargeError("请求内容过大");
      }
      bytesRead += value.byteLength;
      const decoded = decoder.decode(value, { stream: true });
      structure.push(decoded);
      raw += decoded;
    }
  } finally {
    if (!completed) {
      await reader
        .cancel("request body exceeded size limit")
        .catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export async function readResponseJsonBounded(
  response: Response,
  maxBytes: number,
) {
  if (!response.body) throw new Error("模型没有返回响应内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const structure = createJsonStructureScanner();
  let raw = "";
  let bytesRead = 0;
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        structure.push(tail);
        raw += tail;
        completed = true;
        return JSON.parse(raw) as unknown;
      }
      if (value.byteLength > maxBytes - bytesRead) {
        throw new ResponseBodyTooLargeError("模型响应内容过大");
      }
      bytesRead += value.byteLength;
      const decoded = decoder.decode(value, { stream: true });
      structure.push(decoded);
      raw += decoded;
    }
  } finally {
    if (!completed) {
      await reader
        .cancel("provider response exceeded safety limits")
        .catch(() => undefined);
    }
    reader.releaseLock();
  }
}
