import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const vinextCli = path.join(
  projectRoot,
  "node_modules",
  "vinext",
  "dist",
  "cli.js",
);
const args = process.argv.slice(2);
const hasHostname = args.some(
  (argument) =>
    argument === "--hostname" ||
    argument === "-H" ||
    argument.startsWith("--hostname="),
);
if (!hasHostname) {
  args.push("--hostname", "127.0.0.1");
}

const child = spawn(
  process.execPath,
  [vinextCli, "start", ...args],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ALLOW_PRIVATE_LLM_ENDPOINTS:
        process.env.ALLOW_PRIVATE_LLM_ENDPOINTS ?? "true",
      WRANGLER_LOG_PATH:
        process.env.WRANGLER_LOG_PATH ??
        path.join(projectRoot, ".wrangler", "wrangler.log"),
    },
  },
);
child.once("error", (error) => {
  console.error("[Canvasly] Failed to start the local server", error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
