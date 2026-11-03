import { describe, expect, it } from "@effect/vitest";
import { MutantSource, Reporter, Scratch, type Mutant, type RunConfig, type RunReport } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";

const root = decodeURIComponent(new URL("../../../fixtures/tagged-errors/", import.meta.url).pathname).replace(/\/$/, "");
const file = "src/account.ts";
const live = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(Layer.provideMerge(NodeServices.layer));
const config = (location = root): RunConfig => ({
  root: location, tsconfig: "tsconfig.json", include: ["src/**/*.ts"], exclude: [], functionFilter: [],
  jobs: 1, timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 900, outDir: "mutants.out"
});
const mutation = (original: string, id: string, text: string, genre: Mutant["genre"] = "EffectSucceed"): Mutant => {
  const startOffset = original.indexOf("  if (account.frozen)");
  const endOffset = original.indexOf("\n};", startOffset);
  return {
    id, file, functionName: "withdraw", returnType: "Effect<Account, Overdrawn | Frozen>", genre,
    description: id, span: { start: { line: 20, column: 1 }, end: { line: 28, column: 1 } },
    replacement: { startOffset, endOffset, text }, synthetic: false
  };
};
const source = MutantSource.of({ generate: () => Stream.empty, checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) });
const withPorts = <A, E, R>(effect: Effect.Effect<A, E, R>, reports: Array<RunReport>, mutantSource = source) => effect.pipe(
  Effect.provideService(MutantSource, mutantSource),
  Effect.provideService(Reporter, { progress: () => Effect.void, write: (report) => Effect.sync(() => { reports.push(report); }) })
);

describe("real vitest mutation runs", () => {
  it.live("catches a wrong account, misses the untested Frozen path, times out never, and leaves source bytes unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixtureFiles = [file, "test/account.test.ts", "package.json", "tsconfig.json", "README.md"];
      const before = yield* Effect.forEach(fixtureFiles, (name) => fs.readFile(`${root}/${name}`));
      const original = new TextDecoder().decode(before[0]);
      const start = original.indexOf("  if (account.frozen)");
      const end = original.indexOf("\n};", start);
      const body = original.slice(start, end);
      const reports: Array<RunReport> = [];
      const report = yield* withPorts(runMutants(config(), Stream.make(
        { ...mutation(original, "wrong-account", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"), file: `${root}/${file}` },
        mutation(original, "swallow-frozen", `  return (() => {${body}})().pipe(Effect.catchTag("Frozen", () => Effect.succeed(account)));`, "SwallowTag"),
        mutation(original, "never", '  process.stdout.write("mutant-never-pid=" + process.pid + "\\n"); return Effect.never;', "EffectNever")
      )), reports);
      expect(report.results.map((result) => result.outcome)).toEqual(["caught", "missed", "timeout"]);
      expect(report.timeoutMs).toBe(20_000);
      expect(report.baseline.durationMs).toBeGreaterThan(0);
      expect(reports).toHaveLength(1);
      const timedOut = report.results.find((result) => result.outcome === "timeout");
      const pid = /mutant-never-pid=(\d+)/.exec(timedOut?.output ?? "")?.[1];
      expect(pid).toBeDefined();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const alive = yield* spawner.exitCode(ChildProcess.make("ps", ["-p", pid ?? "0", "-o", "pid="]));
      expect(alive).not.toBe(0);
      const after = yield* Effect.forEach(fixtureFiles, (name) => fs.readFile(`${root}/${name}`));
      expect(after).toEqual(before);
    }).pipe(Effect.provide(live)), 30_000);

  it.live("restores the scratch bytes before a later mutant uses the same directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* fs.readFileString(`${root}/${file}`);
      const first = mutation(original, "wrong", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });");
      const width = first.replacement.endOffset - first.replacement.startOffset;
      const wrong = { ...first, replacement: { ...first.replacement, text: first.replacement.text.padEnd(width, " ") } };
      const offset = original.indexOf("account.balance === 0");
      const later: Mutant = { ...first, id: "unused-is-empty", functionName: "isEmpty", genre: "BooleanFlip", replacement: {
        startOffset: offset, endOffset: offset + "account.balance === 0".length, text: "true"
      } };
      const report = yield* withPorts(runMutants(config(), Stream.make(wrong, later)), []);
      expect(report.results.map((result) => result.outcome)).toEqual(["caught", "missed"]);
    }).pipe(Effect.provide(live)), 30_000);

  it.live("stops at a broken baseline without generating or testing mutants", () =>
    Effect.gen(function* () {
      const scratch = yield* Scratch;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch.acquire(root);
      const original = yield* fs.readFileString(`${root}/${file}`);
      yield* dir.apply(mutation(original, "broken", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"));
      let generated = false;
      const result = yield* withPorts(runMutants(config(dir.path)), [], {
        ...source, generate: () => Stream.fromEffect(Effect.sync(() => { generated = true; return mutation(original, "unused", ""); }))
      }).pipe(Effect.flip);
      expect(result._tag).toBe("BaselineFailed");
      expect(generated).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("isolates concurrent workers and skips tests for an unviable mutant", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* fs.readFileString(`${root}/${file}`);
      const start = original.indexOf("  if (account.frozen)");
      const end = original.indexOf("\n};", start);
      const body = original.slice(start, end);
      const report = yield* withPorts(runMutants({ ...config(), jobs: 2 }, Stream.make(
        mutation(original, "wrong", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"),
        mutation(original, "unviable", "  this is not TypeScript"),
        mutation(original, "swallow", `  return (() => {${body}})().pipe(Effect.catchTag("Frozen", () => Effect.succeed(account)));`, "SwallowTag")
      )), [], { ...source, checkViable: (mutant) => Effect.succeed({
        viable: mutant.id !== "unviable", diagnostics: mutant.id === "unviable" ? ["Invalid TypeScript"] : []
      }) });
      expect(Object.fromEntries(report.results.map((result) => [result.mutant.id, result.outcome]))).toEqual({
        wrong: "caught", unviable: "unviable", swallow: "missed"
      });
      expect(report.results.find((result) => result.mutant.id === "unviable")?.testCommand).toEqual([]);
    }).pipe(Effect.provide(live)), 30_000);

  it.live("writes completed results on interruption and releases every scratch directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* Scratch;
      const original = yield* fs.readFileString(`${root}/${file}`);
      const started = yield* Deferred.make<void>();
      const dirs: Array<string> = [];
      const reports: Array<RunReport> = [];
      const run = runMutants(config(), Stream.make(
        mutation(original, "wrong", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"),
        mutation(original, "never", "  return Effect.never;", "EffectNever")
      )).pipe(
        Effect.provideService(MutantSource, source),
        Effect.provideService(Scratch, { acquire: (location) => scratch.acquire(location).pipe(Effect.tap((dir) => Effect.sync(() => { dirs.push(dir.path); }))) }),
        Effect.provideService(Reporter, {
          progress: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          write: (report) => Effect.sync(() => { reports.push(report); })
        })
      );
      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.results[0]?.outcome).toBe("caught");
      for (const dir of dirs) expect(yield* fs.exists(dir)).toBe(false);
    }).pipe(Effect.provide(live)), 30_000);
});
