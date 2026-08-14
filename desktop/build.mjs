import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createPackage } from "@electron/asar";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopDirectory, "..");
const runtimeRoot = path.join(projectRoot, ".sites-runtime");
const vinextCli = path.join(
  projectRoot,
  "node_modules",
  "vinext",
  "dist",
  "cli.js",
);

for (const directory of [
  path.join(runtimeRoot, "home"),
  path.join(runtimeRoot, "tmp"),
  path.join(runtimeRoot, "wrangler", "logs"),
]) {
  await mkdir(directory, { recursive: true });
}

const result = spawnSync(process.execPath, [vinextCli, "build"], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    HOME: path.join(runtimeRoot, "home"),
    TMPDIR: path.join(runtimeRoot, "tmp"),
    NEXT_TELEMETRY_DISABLED: "1",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_PATH: path.join(runtimeRoot, "wrangler", "logs"),
    MINIFLARE_REGISTRY_PATH: path.join(
      runtimeRoot,
      "wrangler",
      "registry",
    ),
  },
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Vinext desktop build failed with exit code ${result.status}`);
}

for (const requiredPath of [
  path.join(projectRoot, "dist", "standalone", "server.js"),
  path.join(projectRoot, "dist", "standalone", "dist", "server", "index.js"),
  path.join(
    projectRoot,
    "dist",
    "standalone",
    "node_modules",
    "vinext",
    "dist",
    "server",
    "prod-server.js",
  ),
]) {
  await access(requiredPath);
}

const standaloneDirectory = path.join(projectRoot, "dist", "standalone");
const serverArchive = path.join(projectRoot, "dist", "canvasly-server.asar");
await rm(serverArchive, { force: true });
await createPackage(standaloneDirectory, serverArchive);
await access(serverArchive);

console.log("Validated Canvasly standalone desktop server.");
