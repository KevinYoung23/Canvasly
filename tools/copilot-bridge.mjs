import { createServer } from "node:http";
import { CopilotClient } from "@github/copilot-sdk";

const port = Number(process.env.COPILOT_BRIDGE_PORT || 4141);
const bridgeKey = process.env.COPILOT_BRIDGE_API_KEY || "";
const client = new CopilotClient({ useLoggedInUser: false });
let clientStarted = false;
let activeRequests = 0;

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
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8_000_000) {
      throw new Error("Request is too large");
    }
  }
  return JSON.parse(body);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image_url") return "[An image reference was supplied to the editor.]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
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
    return writeJson(response, 200, {
      status: "ok",
      authenticated: Boolean(
        process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
      ),
    });
  }

  if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
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
    const { system, conversation } = splitMessages(payload.messages);
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

    return writeJson(response, 200, {
      id: `canvasly-copilot-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: typeof payload.model === "string" ? payload.model : "auto",
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
