import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";

import { viteBuild } from "@alchemy.run/cloudflare/Workers/Sources/Vite";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";

const bundle = await Effect.runPromise(
  Effect.gen(function* () {
    const build = yield* viteBuild(
      ".",
      {},
      {
        framework: "foldkit",
        compatibilityDate: "2026-05-28",
        compatibilityFlags: ["nodejs_compat"],
      },
      "Website",
    );
    return yield* build.serverBundle;
  }).pipe(Effect.provide(NodeServices.layer)),
);
assert.ok(bundle, "Alchemy must produce a Worker upload");
const [entry] = bundle.files;
assert.ok(entry, "Alchemy must produce a Worker entry");
const files = new Map(bundle.files.map((file) => [file.path, file]));
const manifest = JSON.parse(await readFile("dist/server/.vite/manifest.json", "utf8"));
const sourceMap = JSON.parse(await readFile("dist/server/fetch.js.map", "utf8"));
const workerBridgeIncluded = sourceMap.sources.some((source) => /WorkerBridge/.test(source));
const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]));
const directory = "dist/server";
const seen = new Set();
const visit = (path) => {
  if (seen.has(path)) return;
  assert.ok(files.has(path), `Missing uploaded startup module: ${path}`);
  seen.add(path);
  const chunk = byFile.get(posix.relative(directory, path));
  assert.ok(chunk, `Missing Vite graph entry: ${path}`);
  for (const key of chunk.imports ?? []) {
    const dependency = manifest[key];
    assert.ok(dependency, `Missing Vite static import: ${key}`);
    visit(posix.join(directory, dependency.file));
  }
};
visit(entry.path);
const bytes = (file) => new Blob([file.content]).size;
const metrics = {
  worker: "Website",
  alchemy: "2.0.0-beta.85",
  workerBridgeIncluded,
  entry: entry.path,
  entryBytes: bytes(entry),
  startupBytes: [...seen].reduce((sum, path) => sum + bytes(files.get(path)), 0),
  javascriptBytes: bundle.files.filter((file) => file.path.endsWith(".js")).reduce((sum, file) => sum + bytes(file), 0),
  startupModules: [...seen],
};
await mkdir("dist/startup", { recursive: true });
await writeFile("dist/startup/metrics.json", JSON.stringify(metrics, null, 2) + "\n");
process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
