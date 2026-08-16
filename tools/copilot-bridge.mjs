import { createServer } from "node:http";
import { CopilotClient } from "@github/copilot-sdk";

const port = Number(process.env.COPILOT_BRIDGE_PORT || 4141);
const bridgeKey = process.env.COPILOT_BRIDGE_API_KEY || "";
const explicitGitHubToken =
  process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const client = new CopilotClient({
  gitHubToken: explicitGitHubToken || undefined,
  useLoggedInUser: !explicitGitHubToken,
});
let clientStarted = false;
let activeRequests = 0;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRUCTURAL_TOKENS = 50_000;

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function isAuthorized(request) {
  if (!bridgeKey) return true;
  return request.headers.authorization === `Bearer ${bridgeKey}`;
}

async function readJson(request) {
  let body = "";
  let bytesRead = 0;
  const decoder = new TextDecoder();
  const structure = {
    depth: 0,
    structuralTokens: 0,
    inString: false,
    escaped: false,
  };
  for await (const chunk of request) {
    bytesRead += chunk.byteLength;
    if (bytesRead > MAX_REQUEST_BYTES) {
      throw new Error("Request is too large");
    }
    const decoded = decoder.decode(chunk, { stream: true });
    for (const character of decoded) {
      if (structure.inString) {
        if (structure.escaped) structure.escaped = false;
        else if (character === "\\") structure.escaped = true;
        else if (character === '"') structure.inString = false;
        continue;
      }
      if (character === '"') {
        structure.inString = true;
      } else if (character === "{" || character === "[") {
        structure.depth += 1;
        structure.structuralTokens += 1;
        if (structure.depth > MAX_JSON_DEPTH) {
          throw new Error("Request JSON is nested too deeply");
        }
      } else if (character === "}" || character === "]") {
        structure.depth -= 1;
        structure.structuralTokens += 1;
      } else if (character === "," || character === ":") {
        structure.structuralTokens += 1;
      }
      if (
        structure.structuralTokens >
        MAX_JSON_STRUCTURAL_TOKENS
      ) {
        throw new Error("Request JSON is too complex");
      }
    }
    body += decoded;
  }
  body += decoder.decode();
  return JSON.parse(body);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (
        ["text", "input_text", "output_text"].includes(part.type) &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      if (part.type === "image_url" || part.type === "input_image") {
        return "[An image reference was supplied to the editor.]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function responseInputMessages(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === "object" && "role" in item)
    .map((item) => ({
      role: item.role === "developer" ? "system" : item.role,
      content: item.content,
    }));
}

function splitMessages(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  const system = normalized
    .filter((message) => message?.role === "system")
    .map((message) => messageText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const conversation = normalized
    .filter((message) => message?.role !== "system")
    .map((message) => `${String(message?.role || "user").toUpperCase()}:\n${messageText(message?.content)}`)
    .join("\n\n");
  return { system, conversation };
}

async function ensureClient() {
  if (clientStarted) return;
  await client.start();
  clientStarted = true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await ensureClient();
      const auth = await client.getAuthStatus();
      return writeJson(response, 200, {
        status: "ok",
        authenticated: Boolean(auth?.isAuthenticated),
        authType: explicitGitHubToken ? "token" : "logged-in-user",
      });
    } catch (error) {
      return writeJson(response, 503, {
        status: "unavailable",
        authenticated: false,
        authType: explicitGitHubToken ? "token" : "logged-in-user",
        error: error instanceof Error ? error.message : "Copilot login unavailable",
      });
    }
  }

  const usesResponses = url.pathname.endsWith("/responses");
  const usesChatCompletions = url.pathname.endsWith("/chat/completions");
  if (request.method !== "POST" || (!usesResponses && !usesChatCompletions)) {
    return writeJson(response, 404, { error: { message: "Not found" } });
  }

  if (!isAuthorized(request)) {
    return writeJson(response, 401, { error: { message: "Invalid bridge API key" } });
  }

  if (activeRequests >= 2) {
    return writeJson(response, 429, { error: { message: "Copilot bridge is busy" } });
  }

  activeRequests += 1;
  let session;
  try {
    const payload = await readJson(request);
    const messages = usesResponses
      ? responseInputMessages(payload.input)
      : payload.messages;
    const { system, conversation } = splitMessages(messages);
    if (!conversation.trim()) {
      return writeJson(response, 400, { error: { message: "No user message supplied" } });
    }

    await ensureClient();
    session = await client.createSession({
      clientName: "canvasly-html-editor",
      model: typeof payload.model === "string" && payload.model ? payload.model : "auto",
      availableTools: [],
      systemMessage: {
        mode: "append",
        content: system || "Return the requested final answer directly without using tools.",
      },
    });
    const result = await session.sendAndWait({ prompt: conversation }, 120_000);
    const content = result?.data?.content;
    if (typeof content !== "string" || !content) {
      throw new Error("Copilot returned no content");
    }

    const id = `canvasly-copilot-${Date.now()}`;
    const model = typeof payload.model === "string" ? payload.model : "auto";
    if (usesResponses) {
      return writeJson(response, 200, {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model,
        output_text: content,
        output: [],
      });
    }

    return writeJson(response, 200, {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
    });
  } catch (error) {
    return writeJson(response, 502, {
      error: {
        message: error instanceof Error ? error.message : "Copilot request failed",
      },
    });
  } finally {
    activeRequests -= 1;
    if (session) {
      try {
        await session.disconnect();
      } catch {
        // The bridge remains usable even if a finished session cannot disconnect cleanly.
      }
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Canvasly Copilot bridge listening on http://0.0.0.0:${port}`);
});

async function shutdown() {
  server.close();
  if (clientStarted) await client.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
