import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopDirectory, "..");
const electronBuilderCli = path.join(
  projectRoot,
  "node_modules",
  "electron-builder",
  "cli.js",
);
const environment = { ...process.env };
if (
  !environment.CSC_LINK &&
  !environment.CSC_NAME &&
  environment.CSC_IDENTITY_AUTO_DISCOVERY === undefined
) {
  environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}

const result = spawnSync(
  process.execPath,
  [electronBuilderCli, ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: environment,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Electron packaging failed with exit code ${result.status}`);
}
