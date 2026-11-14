import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Scratch } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ScratchLive } from "../src/Scratch.ts";

// Filesystem-only proofs. No test backend or replacement executes.
for (const phase of ["scope", "dependency", "node_modules", "access", "mkdir-destination", "copy-destination", "symlink-destination"] as const) it.live(`keeps permission handling on the correct side of dependency copying (${phase})`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const console = yield* Console.Console;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "dependency-permissions-" }));
  for (const folder of ["dist/node_modules/good", "dist/node_modules/bad", "dist/node_modules/@blocked/pkg"]) yield* fs.makeDirectory(`${root}/${folder}`, { recursive: true });
  yield* fs.writeFileString(`${root}/.gitignore`, "dist/\n");
  yield* fs.writeFileString(`${root}/package.json`, '{"exports":"./dist/index.js"}');
  const original = "export const value = 1;";
  yield* fs.writeFileString(`${root}/dist/index.js`, original);
  yield* fs.writeFileString(`${root}/dist/blocked.js`, original);
  yield* fs.writeFileString(`${root}/dist/node_modules/good/index.js`, "export const good = true;");
  const child = yield* ChildProcess.make("git", ["-C", root, "init", "--quiet"], { stdin: "ignore" });
  const [code] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
  expect(Number(code)).toBe(0);
  const denied = `${root}/dist/${phase === "scope" ? "node_modules/@blocked" : phase === "node_modules" ? "node_modules" : phase === "access" ? "blocked.js" : "node_modules/bad"}`;
  const permission = (method: string, location: string) => Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({
    _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: location
  })));
  const warnings: string[] = [];
  const tracked: FileSystem.FileSystem = { ...fs,
    readDirectory: path => (phase === "scope" || phase === "node_modules") && path === denied ? permission("readDirectory", path) : fs.readDirectory(path),
    realPath: path => phase === "dependency" && path === denied ? permission("realPath", path) : fs.realPath(path),
    access: (path, options) => phase === "access" && path === denied ? permission("access", path) : fs.access(path, options),
    makeDirectory: (path, options) => phase === "mkdir-destination" && !path.startsWith(root) && path.endsWith("/dist/node_modules/@blocked")
      ? permission("makeDirectory", path) : fs.makeDirectory(path, options),
    // The Node adapter identifies multi-path errors by the first argument,
    // even when a copyFile or symlink failed at its destination.
    copyFile: (from, to) => phase === "copy-destination" && from === `${root}/dist/index.js` ? permission("copyFile", from) : fs.copyFile(from, to),
    symlink: (from, to) => phase === "symlink-destination" && from === denied ? permission("symlink", from) : fs.symlink(from, to)
  };
  const result = yield* Scratch.use(scratch => scratch.acquire(root)).pipe(Effect.provide(ScratchLive),
    Effect.provideService(FileSystem.FileSystem, tracked),
    Effect.provideService(Console.Console, { ...console, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }), Effect.result);
  if (phase.endsWith("destination")) {
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("ScratchError");
    expect(warnings).toEqual([]);
  } else {
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(yield* fs.readFileString(`${result.success.path}/dist/index.js`)).toBe(original);
      const relative = denied.slice(root.length + 1);
      expect(yield* fs.exists(`${result.success.path}/${relative}`)).toBe(false);
      if (phase !== "node_modules") expect(yield* fs.readFileString(`${result.success.path}/dist/node_modules/good/index.js`)).toContain("good = true");
    }
    expect(warnings).toEqual([`Warning: scratch copy skipped an unreadable ignored tree: ${denied}`]);
  }
  expect(yield* fs.readFileString(`${root}/dist/index.js`)).toBe(original);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
