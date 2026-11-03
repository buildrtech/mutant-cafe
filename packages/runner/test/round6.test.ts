import { expect, it } from "@effect/vitest";
import { Scratch } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { acquireProcessTree, ProcessInspector } from "../src/ProcessTree.ts";
import { ScratchLive } from "../src/Scratch.ts";

it.live("bounds interrupted cleanup even when a process inspector never replies", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const entered = yield* Deferred.make<void>();
  const ledgers: string[] = []; const warnings: string[] = [];
  const original = yield* Console.Console;
  const tracked: FileSystem.FileSystem = { ...fs, makeTempDirectory: options => fs.makeTempDirectory(options).pipe(Effect.tap(path => Effect.sync(() => { ledgers.push(path); }))) };
  yield* Effect.addFinalizer(() => Effect.forEach(ledgers, path => fs.remove(path, { recursive: true, force: true }).pipe(Effect.orDie), { discard: true }));
  const task = Effect.scoped(Effect.gen(function* () {
    const tree = yield* acquireProcessTree("/synthetic/cleanup-deadline");
    yield* tree.reap([]);
  })).pipe(Effect.provideService(FileSystem.FileSystem, tracked), Effect.provideService(ProcessInspector, { inspect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }),
    Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  const fiber = yield* task.pipe(Effect.forkChild);
  yield* Deferred.await(entered);
  const started = performance.now();
  yield* Fiber.interrupt(fiber);
  expect(performance.now() - started).toBeLessThan(5500);
  expect(warnings.some(message => /budget|deadline/.test(message))).toBe(true);
  expect(ledgers).toHaveLength(1);
  expect(yield* fs.exists(`${ledgers[0]}/pids.jsonl`)).toBe(true); // uncertain ownership keeps evidence
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 12_000);

it.live("still kills birth-verified ledger children when the next inspection stalls", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const original = yield* Console.Console; const warnings: string[] = [];
  const signals: Array<{ pid: number; signal: string; inspections: number }> = [];
  const birth = "Tue Nov 3 00:00:00 2026"; let inspections = 0;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "deadline-signal-proof-" });
  const tree = yield* acquireProcessTree().pipe(Effect.provideService(FileSystem.FileSystem, { ...fs, makeTempDirectory: options => fs.makeTempDirectory({ ...options, directory }) }), Effect.provideService(ProcessInspector, {
    inspect: () => ++inspections === 1 ? Effect.succeed({ stdout: `2147483000 1 2147483000 S ${birth} parent\n2147483001 1 2147483001 S ${birth} reused\n2147483003 2147483000 2147483003 S ${birth} unlabelled-child\n2147483004 2147483003 2147483004 S ${birth} unlabelled-grandchild\n2147483005 1 2147483005 S ${birth} retained-service\n2147483006 2147483005 2147483006 S ${birth} retained-child\n` }) : Effect.never,
    signal: (pid, signal) => { signals.push({ pid, signal, inspections }); }
  }));
  yield* fs.writeFileString(tree.env.MUTANT_CAFE_PROCESS_LEDGER, [
    { pid: 2147483000, birth },
    { pid: 2147483001, birth: "Mon Nov 2 00:00:00 2026" }, // PID was reused
    { pid: 2147483002, birth }, // no current birth match
    { pid: 2147483005, birth },
    { pid: 2147483006, birth }
  ].map(item => JSON.stringify(item)).join("\n"));
  const result = yield* tree.reap([], [{ pid: 2147483005, birth }]).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  expect(result).toBe("warning");
  expect(signals).toEqual([2147483000, 2147483003, 2147483004].map(pid => ({ pid, signal: "SIGKILL", inspections: 2 })));
  expect(warnings.some(message => message.includes("unverified ledger PIDs 2147483001, 2147483002 were not signalled"))).toBe(true);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 10_000);

for (const kind of ["directory", "file", "dependency"] as const) it.live(`skips a source ${kind} removed after directory enumeration`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scratch-vanish-" });
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  const parent = kind === "dependency" ? `${root}/node_modules` : root;
  if (kind === "dependency") yield* fs.makeDirectory(parent);
  const vanished = `${parent}/vanished`;
  if (kind === "file") yield* fs.writeFileString(vanished, "temporary");
  else { yield* fs.makeDirectory(vanished); yield* fs.writeFileString(`${vanished}/partial.txt`, "temporary"); }
  let removed = false;
  const tracked: FileSystem.FileSystem = { ...fs, readDirectory: path => fs.readDirectory(path).pipe(Effect.tap(() => path === parent && !removed ? fs.remove(vanished, { recursive: true }).pipe(Effect.tap(() => Effect.sync(() => { removed = true; }))) : Effect.void)) };
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked));
  const copied = yield* scratch.acquire(root);
  expect(removed).toBe(true);
  expect(yield* fs.readFileString(`${copied.path}/keep.txt`)).toBe("keep");
  expect(yield* fs.exists(`${copied.path}/${kind === "dependency" ? "node_modules/" : ""}vanished`)).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("does not mask a destination NotFound when its source still exists", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scratch-destination-" });
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  const tracked: FileSystem.FileSystem = { ...fs, copyFile: (_from, to) => Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({ _tag: "NotFound", module: "FileSystem", method: "copyFile", pathOrDescriptor: to }))) };
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked));
  const result = yield* scratch.acquire(root).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.message).toContain("NotFound");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("does not hide permission errors while copying a source that still exists", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scratch-denied-" });
  yield* fs.writeFileString(`${root}/denied.txt`, "keep");
  const tracked: FileSystem.FileSystem = { ...fs, realPath: path => path === `${root}/denied.txt` ? Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "realPath", pathOrDescriptor: path }))) : fs.realPath(path) };
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked));
  const result = yield* scratch.acquire(root).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.message).toContain("PermissionDenied");
  expect(yield* fs.readFileString(`${root}/denied.txt`)).toBe("keep");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
