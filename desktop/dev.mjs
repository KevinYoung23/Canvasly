import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopDirectory, "..");
const runtimeRoot = path.join(projectRoot, ".sites-runtime");
const developmentUrl = "http://127.0.0.1:5173";
const viteCli = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const electronBinary = require("electron");

await mkdir(path.join(runtimeRoot, "wrangler", "logs"), { recursive: true });

const vite = spawn(
  process.execPath,
  [viteCli, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ALLOW_PRIVATE_LLM_ENDPOINTS: "true",
      WRANGLER_WRITE_LOGS: "false",
      WRANGLER_LOG_PATH: path.join(runtimeRoot, "wrangler", "logs"),
      MINIFLARE_REGISTRY_PATH: path.join(
        runtimeRoot,
        "wrangler",
        "registry",
      ),
    },
  },
);

let electron = null;
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
  process.exitCode = exitCode;
}

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
vite.once("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch(developmentUrl);
    if (response.ok) break;
  } catch {
    // The Vite process reports actionable startup errors through inherited stdio.
  }
  if (attempt === 119) {
    stop(1);
    throw new Error("Canvasly development server did not start within 60 seconds");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

electron = spawn(electronBinary, [projectRoot], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    CANVASLY_DESKTOP_URL: developmentUrl,
  },
});
electron.once("exit", (code) => stop(code ?? 0));
