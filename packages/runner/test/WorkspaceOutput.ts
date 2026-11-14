import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

/** A prebuilt two-package workspace. No build or mutation is executed here. */
export const builtWorkspace = (withIgnoredCheckout = false) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "workspace-output-" }));
  const library = `${root}/packages/library`;
  const consumer = `${root}/packages/consumer`;
  for (const dir of [library, consumer, `${root}/node_modules/@fixture`]) yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${root}/package.json`, '{"private":true,"type":"module"}');
  yield* fs.writeFileString(`${root}/pnpm-workspace.yaml`, 'packages:\n  - "packages/*"\n');
  yield* fs.writeFileString(`${root}/.gitignore`, 'node_modules/\ndist/\ngenerated/\nlegacy/\nesm/\ntypes/\n.vendor/\n.env*\n');
  yield* fs.writeFileString(`${library}/package.json`, JSON.stringify({ name: "@fixture/library", type: "module",
    main: "legacy/index.js", module: "./esm/index.js", types: "./types/index.d.ts",
    exports: { ".": { import: "./dist/index.js", default: "./dist/index.js" }, "./feature/*": "./dist/features/*.js" },
    imports: { "#generated": "./generated/value.js" } }));
  const artifacts = {
    "dist/index.js": 'import { value } from "#generated"; import { bonus } from "../private-generated/bonus.js"; import { embedded } from "./node_modules/embedded/index.js"; export { feature } from "./util.js"; export const answer = value + bonus + embedded;',
    "dist/util.js": "export const feature = 5;",
    "dist/node_modules/embedded/package.json": '{"type":"module"}',
    "dist/node_modules/embedded/index.js": "export const embedded = 0;",
    "dist/features/extra.js": "export const extra = 17;",
    "generated/value.js": "export const value = 40;",
    "private-generated/bonus.js": "export const bonus = 2;",
    "legacy/index.js": "export const legacy = true;",
    "esm/index.js": "export const esm = true;",
    "types/index.d.ts": "export declare const answer: number;"
  };
  for (const [file, text] of Object.entries(artifacts)) {
    yield* fs.makeDirectory(`${library}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
    yield* fs.writeFileString(`${library}/${file}`, text);
  }
  yield* fs.writeFileString(`${consumer}/package.json`, '{"name":"@fixture/consumer","type":"module","scripts":{"test":"vitest run"},"dependencies":{"@fixture/library":"workspace:*"}}');
  yield* fs.writeFileString(`${consumer}/tsconfig.json`, '{"compilerOptions":{"noEmit":true},"include":["*.ts"]}');
  yield* fs.writeFileString(`${consumer}/.env.test`, 'VITE_FIXTURE_VALUE=present\n');
  yield* fs.writeFileString(`${consumer}/value.test.ts`, 'import { expect, it } from "vitest"; import { answer, feature } from "@fixture/library"; import { extra } from "@fixture/library/feature/extra"; it("loads prebuilt workspace exports", () => { expect(answer).toBe(42); expect(feature).toBe(5); expect(extra).toBe(17); expect(import.meta.env.VITE_FIXTURE_VALUE).toBe("present"); });');
  yield* fs.writeFileString(`${consumer}/vitest.config.ts`, 'export default { test: { maxWorkers: 1, include: ["value.test.ts"] } };');
  if (withIgnoredCheckout) {
    yield* fs.makeDirectory(`${root}/.vendor/checkout/node_modules`, { recursive: true });
    yield* fs.symlink(`${root}/absent`, `${root}/.vendor/checkout/dangling`);
  }
  const dependencies = decodeURIComponent(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url).pathname);
  yield* fs.symlink(`${dependencies}/vitest`, `${root}/node_modules/vitest`);
  yield* fs.symlink(library, `${root}/node_modules/@fixture/library`);
  yield* Effect.scoped(Effect.gen(function* () {
    const child = yield* ChildProcess.make("git", ["-C", root, "init", "--quiet"], { stdin: "ignore" });
    const [code] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
    if (Number(code) !== 0) return yield* Effect.die(`Git fixture initialization failed: ${code}`);
  }));
  yield* fs.writeFileString(`${root}/.git/fixture-excludes`, "private-generated/\n");
  yield* Effect.scoped(Effect.gen(function* () {
    const child = yield* ChildProcess.make("git", ["-C", root, "config", "core.excludesFile", `${root}/.git/fixture-excludes`], { stdin: "ignore" });
    const [code] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
    if (Number(code) !== 0) return yield* Effect.die(`Git fixture excludes setup failed: ${code}`);
  }));
  return { root, library, consumer, artifacts };
});
