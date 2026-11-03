import { expect, it } from "@effect/vitest";
import { Scratch } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { inspectScratchCwd } from "../src/ProcessTree.ts";
import { ScratchLive } from "../src/Scratch.ts";

it.live("filters exited PIDs and preserves lsof exit-1 partial cwd output", () => Effect.gen(function* () {
  let requested: ReadonlyArray<number> = [];
  const result = yield* inspectScratchCwd([41, 42, 43], {
    live: pid => pid !== 42, // the snapshot's ps already exited
    read: pids => {
      requested = pids;
      // PID 43 exited between the liveness check and lsof. PID 41 was read.
      return Promise.reject(Object.assign(new Error("one PID disappeared"), { code: 1, killed: false, signal: null, stdout: "p41\nn/synthetic/scratch\n" }));
    }
  });
  expect(requested).toEqual([41, 43]);
  expect(result.stdout).toBe("p41\nn/synthetic/scratch\n");
}));

it.live("does not launch lsof when every candidate has exited", () => Effect.gen(function* () {
  let invoked = false;
  const result = yield* inspectScratchCwd([42], { live: () => false, read: () => { invoked = true; return Promise.resolve({ stdout: "" }); } });
  expect(invoked).toBe(false);
  expect(result.stdout).toBe("");
}));

for (const error of [
  { code: 1, killed: true, signal: "SIGTERM", stdout: "partial" },
  { code: "ABORT_ERR", stdout: "partial" },
  { code: 2, killed: false, signal: null, stdout: "partial" }
]) it.live(`does not hide an aborted or failed cwd inspection (${error.code}/${error.signal ?? "none"})`, () => Effect.gen(function* () {
  const result = yield* inspectScratchCwd([41], { live: () => true, read: () => Promise.reject(Object.assign(new Error("inspection failed"), error)) }).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("TestSpawnError");
}));

it.live("keeps dangling source symlinks as copy failures", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scratch-dangling-" });
  yield* fs.symlink(`${root}/absent`, `${root}/dangling`);
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive));
  const result = yield* scratch.acquire(root).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.message).toContain("NotFound");
  expect((yield* fs.lstat(`${root}/dangling`)).type).toBe("SymbolicLink");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("routes scratch removal failures through the stderr console warning boundary", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const original = yield* Console.Console;
  const parent = yield* fs.makeTempDirectoryScoped({ prefix: "scratch-removal-proof-" });
  const root = `${parent}/source`;
  yield* fs.makeDirectory(root);
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  const warnings: string[] = [];
  let copied = "";
  const tracked: FileSystem.FileSystem = { ...fs,
    makeTempDirectory: options => fs.makeTempDirectory({ ...options, directory: parent }).pipe(Effect.tap(path => Effect.sync(() => { copied = path; }))),
    remove: (path, options) => path === copied ? Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove", pathOrDescriptor: path }))) : fs.remove(path, options)
  };
  yield* Effect.scoped(Effect.gen(function* () {
    const scratch = yield* Scratch;
    yield* scratch.acquire(root);
  }).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked))).pipe(
    Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("scratch removal did not complete");
  expect(yield* fs.readFileString(`${copied}/keep.txt`)).toBe("keep"); // evidence retained until this proof's parent scope closes
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
