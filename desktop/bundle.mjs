import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopDirectory, "..");
const outputDirectory = path.join(projectRoot, ".desktop-build");
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(desktopDirectory, "main.mjs")],
  outfile: path.join(outputDirectory, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  banner: {
    js: 'import { createRequire as __canvaslyCreateRequire } from "node:module"; const require = __canvaslyCreateRequire(import.meta.url);',
  },
  legalComments: "none",
  sourcemap: false,
});
await copyFile(
  path.join(desktopDirectory, "preload.cjs"),
  path.join(outputDirectory, "preload.cjs"),
);
const runtimePackageDirectory = path.join(
  outputDirectory,
  "node_modules",
  "canvasly-desktop-runtime",
);
await mkdir(runtimePackageDirectory, { recursive: true });
await writeFile(
  path.join(runtimePackageDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "canvasly-desktop-runtime",
      version: packageJson.version,
      private: true,
      main: "index.js",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(
  path.join(runtimePackageDirectory, "index.js"),
  "'use strict';\n",
  "utf8",
);
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "canvasly-desktop",
      version: packageJson.version,
      private: true,
      description: packageJson.description,
      author: packageJson.author,
      main: "main.mjs",
      type: "module",
      dependencies: {
        "canvasly-desktop-runtime": packageJson.version,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log("Bundled Canvasly Electron runtime.");
