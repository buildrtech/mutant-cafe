import { describe, expect, it } from "@effect/vitest";
import { MutantSource, Reporter, TestSpawnError, type Mutant, type RunConfig } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";
import { acquireProcessTree, ProcessInspector } from "../src/ProcessTree.ts";
import { startupCost } from "../src/Mode.ts";

const workspace = decodeURIComponent(new URL("../../../", import.meta.url).pathname).replace(/\/$/, "");
const live = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(Layer.provideMerge(NodeServices.layer));
const source = MutantSource.of({ notMutated: () => Effect.succeed([]), generate: () => Stream.empty,
  checkViable: mutant => Effect.succeed({ viable: mutant.id !== "bad", diagnostics: [] }) });
const config = (root: string, cold = false): RunConfig => ({ root, cold, warm: !cold, tsconfig: "tsconfig.json", include: ["src/**/*.ts"], exclude: [], functionFilter: [], jobs: 1,
  timeoutMultiplier: 2, minimumTimeoutMs: 20_000, neverTimeoutMs: 1000, outDir: "mutants.out" });
const replace = (original: string, from: string, text: string, id: string, file = "src/value.ts", genre: Mutant["genre"] = "EffectSucceed"): Mutant => {
  const offset = original.indexOf(from);
  if (offset < 0) throw new Error(`Missing fixture target: ${from}`);
  return { id, file, functionName: id, returnType: "fixture", genre, description: id, synthetic: false,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, replacement: { startOffset: offset, endOffset: offset + from.length, text } };
};
const run = (settings: RunConfig, mutants: ReadonlyArray<Mutant>) => runMutants(settings, Stream.fromIterable(mutants)).pipe(
  Effect.provideService(MutantSource, source), Effect.provideService(Reporter, { progress: () => Effect.void, write: () => Effect.void }));
const fixture = (code: string, check: string, options = "") => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ directory: `${workspace}/packages/runner/test/fixtures`, prefix: "round-three-" });
  yield* fs.makeDirectory(`${root}/src`);
  yield* fs.makeDirectory(`${root}/checks`);
  yield* fs.writeFileString(`${root}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, noEmit: true }, include: ["src"] }));
  yield* fs.writeFileString(`${root}/vitest.config.ts`, `export default { test: { maxWorkers: 2, include: ["checks/*.mjs"], ${options} } };`);
  yield* fs.writeFileString(`${root}/src/value.ts`, code);
  yield* fs.writeFileString(`${root}/checks/value.mjs`, check);
  return root;
});
const value = 'import * as Effect from "effect/Effect"; export const value = () => Effect.succeed(1);';
const check = 'import { it, expect } from "vitest"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; it("reads the value", async () => expect(await Effect.runPromise(value())).toBe(1));';

describe("round three regression proof", () => {
  for (const cold of [true, false]) {
    it.live(`${cold ? "cold" : "warm"}: budgets a never reached from beforeEach with default timeouts`, () => Effect.gen(function* () {
      const root = yield* fixture(value, 'import { beforeEach, it, expect } from "vitest"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; let actual; beforeEach(async () => { actual = await Effect.runPromise(value()); }); it("uses the hook result", () => expect(actual).toBe(1));');
      const report = yield* run(config(root, cold), [replace(value, "Effect.succeed(1)", "Effect.never", "never", "src/value.ts", "EffectNever")]);
      expect(report.results[0]?.outcome).toBe("caught");
      expect(report.results[0]?.timeoutMs).toBe(2000);
      expect(report.results[0]?.output).toContain("Hook timed out in 2000ms");
      const allowance = Math.ceil(Object.values(report.baseline.testFileDurations ?? {}).reduce((sum, duration) => sum + duration, 0)) + (report.baseline.startupMs ?? 0);
      expect(report.results[0]?.outerTimeoutMs).toBe(2000 + allowance);
      expect(report.hostRestarts).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

    it.live(`${cold ? "cold" : "warm"}: honors ignored unhandled errors in a passing baseline`, () => Effect.gen(function* () {
      const root = yield* fixture(value, 'import { it, expect } from "vitest"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; it("still checks the value", async () => { Promise.reject(new Error("ignored-fixture-error")); await new Promise(resolve => setTimeout(resolve, 25)); expect(await Effect.runPromise(value())).toBe(1); });', 'dangerouslyIgnoreUnhandledErrors: true,');
      const report = yield* run(config(root, cold), [replace(value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong")]);
      expect(report.results[0]?.outcome).toBe("caught");
      expect(report.failure).toBeUndefined();
      expect(report.hostRestarts).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

    it.live(`${cold ? "cold" : "warm"}: an external probe setup cannot match broad test includes`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fixture(value, check);
      yield* fs.writeFileString(`${root}/vitest.config.ts`, 'export default { test: { maxWorkers: 2, include: ["**/*.mjs"] } };');
      const orphan = "export const orphan = () => true;";
      yield* fs.writeFileString(`${root}/src/orphan.ts`, orphan);
      const report = yield* run(config(root, cold), [replace(orphan, "true", "false", "orphan", "src/orphan.ts", "BooleanFlip")]);
      expect(report.results[0]?.outcome).toBe("untested");
      expect(report.results[0]?.testCommand).toEqual([]);
      expect(report.reachabilityProbes?.map(probe => probe.status)).toEqual(["unreachable"]);
    }).pipe(Effect.scoped, Effect.provide(live)), 20_000);
  }

  it.live("catches a mutant rejection without giving up warm execution", () => Effect.gen(function* () {
    const root = yield* fixture(value, 'import { it, expect } from "vitest"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; it("reads the value", async () => { expect(await Effect.runPromise(value())).toBe(1); await new Promise(resolve => setTimeout(resolve, 25)); });');
    const report = yield* run(config(root), [replace(value, "Effect.succeed(1)", 'Effect.sync(() => { Promise.reject(new Error("mutant-unhandled")); return 1; })', "rejection"), replace(value, "Effect.succeed(1)", "Effect.succeed(1)", "control")]);
    expect(report.results.map(result => result.outcome)).toEqual(["caught", "missed"]);
    expect(report.results.every(result => result.output?.includes("mutant-warm:selected:"))).toBe(true);
    expect(report.hostRestarts).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("uses one quiet selector for cold files with nonempty selections", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture(value, 'import { it, expect } from "vitest"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; import { second } from "../src/second.ts"; import { third } from "../src/third.ts"; it("reads all modules", async () => { expect(await Effect.runPromise(value())).toBe(1); expect(second()).toBe(true); expect(third()).toBe(true); });', 'isolate: false,');
    const second = "export const second = () => true;";
    const third = "export const third = () => true;";
    yield* fs.writeFileString(`${root}/src/second.ts`, second);
    yield* fs.writeFileString(`${root}/src/third.ts`, third);
    let hosts = 0;
    const tracked: FileSystem.FileSystem = { ...fs, makeTempDirectoryScoped: options => fs.makeTempDirectoryScoped(options).pipe(Effect.tap(() => Effect.sync(() => { if (options?.prefix === "mutant-warm-") hosts++; }))) };
    const warnings: string[] = [];
    const original = yield* Console.Console;
    const report = yield* run(config(root, true), [replace(value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong"),
      replace(second, "true", "false", "second", "src/second.ts", "BooleanFlip"), replace(third, "true", "false", "third", "src/third.ts", "BooleanFlip")]).pipe(
      Effect.provide(TestRunnerLive), Effect.provideService(FileSystem.FileSystem, tracked),
      Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
    expect(report.results.map(result => result.outcome)).toEqual(["caught", "caught", "caught"]);
    expect(report.reachabilityProbes).toEqual([]);
    expect(hosts).toBe(1);
    expect(warnings.some(message => message.includes("warm Vitest unavailable"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("uses observed concurrency and preserves parity at Vitest's default worker count", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ directory: `${workspace}/packages/runner/test/fixtures`, prefix: "default-workers-" });
    yield* fs.copy(`${workspace}/packages/runner/test/fixtures/parallel`, root);
    yield* fs.writeFileString(`${root}/vitest.config.ts`, 'export default { test: { include: ["checks/*.fixture.mjs"] } };');
    const original = yield* fs.readFileString(`${root}/src/value.ts`);
    const mutants = [replace(original, "Effect.succeed(1)", "Effect.succeed(2)", "wrong"), replace(original, "unused = () => true", "unused = () => false", "unused", "src/value.ts", "BooleanFlip")];
    const cold = yield* run(config(root, true), mutants);
    const warm = yield* run(config(root), mutants);
    expect(cold.results.map(result => result.outcome)).toEqual(["caught", "missed"]);
    expect(warm.results.map(result => result.outcome)).toEqual(["caught", "missed"]);
    expect(cold.baseline.testConcurrency).toBeGreaterThan(1);
    expect(warm.baseline.testConcurrency).toBeGreaterThan(1);
    expect(warm.baseline.testConcurrency).toBe(cold.baseline.testConcurrency);
  }).pipe(Effect.scoped, Effect.provide(live)), 40_000);

  it.live("uses cold execution for global setup services", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture(value, 'import { it, expect, inject } from "vitest"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; it("uses its setup service", async () => { const expected = Number(await (await fetch("http://127.0.0.1:" + inject("servicePort"))).text()); expect(await Effect.runPromise(value())).toBe(expected); });', 'globalSetup: ["./setup.mjs"],');
    yield* fs.writeFileString(`${root}/setup.mjs`, 'import { spawn } from "node:child_process"; export default async function(project) { const child = spawn(process.execPath, ["-e", `const server = require("node:http").createServer((request, response) => response.end("1")); server.listen(0, "127.0.0.1", () => console.log(server.address().port));`], { stdio: ["ignore", "pipe", "inherit"] }); const port = await new Promise(resolve => child.stdout.once("data", chunk => resolve(Number(String(chunk).trim())))); project.provide("servicePort", port); return () => child.kill("SIGTERM"); }');
    const report = yield* run(config(root), [replace(value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong"), replace(value, "Effect.succeed(1)", "Effect.succeed(1)", "control")]);
    expect(report.results.map(result => result.outcome)).toEqual(["caught", "missed"]);
    expect(report.hostRestarts).toBe(0);
    expect(report.baseline.runnerMode).toBe("cold");
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("continues testing after process inspection fails and warns with tracked PIDs", () => Effect.gen(function* () {
    const root = yield* fixture(value, check);
    const warnings: string[] = [];
    const originalConsole = yield* Console.Console;
    const report = yield* run(config(root), [replace(value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong"), replace(value, "Effect.succeed(1)", "Effect.succeed(1)", "control")]).pipe(
      Effect.provideService(ProcessInspector, { inspect: () => Effect.fail(new TestSpawnError({ command: ["ps"], message: "injected inspection failure" })) }),
      Effect.provideService(Console.Console, { ...originalConsole, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
    expect(report.results.map(result => result.outcome)).toEqual(["caught", "missed"]);
    expect(warnings.some(message => message.includes("tracked PIDs") && message.includes("continuing"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("does not signal or count a zombie as a surviving process", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tree = yield* acquireProcessTree().pipe(Effect.provideService(ProcessInspector, {
      inspect: () => Effect.succeed({ stdout: "2147483000 1 2147483000 Z Tue Nov 3 00:00:00 2026\n" })
    }));
    yield* fs.writeFileString(tree.env.MUTANT_CAFE_PROCESS_LEDGER, JSON.stringify({ pid: 2147483000, birth: "Tue Nov 3 00:00:00 2026" }) + "\n");
    expect(yield* tree.reap([])).toBe("clean");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it("reserves startup for unopened scratch copies", () => {
    expect(startupCost([100], 3)).toBe(200);
    expect(startupCost([100, 400], 2)).toBe(0);
    expect(startupCost([100, 400], 3)).toBe(400);
  });

  it.live("auto excludes unviable and probe-cached mutants", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture(value, check);
    const orphan = "export const orphan = () => true;";
    yield* fs.writeFileString(`${root}/src/orphan.ts`, orphan);
    const report = yield* run({ ...config(root), warm: false, cold: false, jobs: 2 }, [
      replace(value, "Effect.succeed(1)", "Effect.succeed(3)", "bad"),
      replace(orphan, "true", "false", "orphan", "src/orphan.ts", "BooleanFlip"),
      replace(value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong")
    ]);
    expect(report.results.map(result => [result.mutant.id, result.outcome]).sort()).toEqual([["bad", "unviable"], ["orphan", "untested"], ["wrong", "caught"]]);
    expect(report.baseline.calibration?.mutants ?? report.baseline.testableMutants).toBe(1);
    expect(report.baseline.runnerMode).toBe("cold");
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("excludes first-touch filesystem setup from both measured baselines", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture(value, check);
    const marker = `${root}/first-touch.txt`;
    yield* fs.writeFileString(`${root}/checks/value.mjs`, `import { it, expect } from "vitest"; import { existsSync, writeFileSync } from "node:fs"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; it("loads its data", async () => { if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, "primed"); await new Promise(resolve => setTimeout(resolve, 3000)); } expect(await Effect.runPromise(value())).toBe(1); });`);
    const report = yield* run({ ...config(root), warm: false, cold: false }, [replace(value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong-one"), replace(value, "Effect.succeed(1)", "Effect.succeed(3)", "wrong-two")]);
    expect(report.baseline.calibration).toBeDefined();
    expect(report.baseline.calibration!.warmMs).toBeLessThan(2500);
    expect(report.baseline.calibration!.coldMs).toBeLessThan(2500);
    expect(report.results.map(result => result.outcome)).toEqual(["caught", "caught"]);
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("auto executes no second baseline after the first fails", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture(value, check);
    const marker = `${root}/runs.txt`;
    yield* fs.writeFileString(marker, "");
    yield* fs.writeFileString(`${root}/checks/value.mjs`, `import { it, expect } from "vitest"; import { appendFileSync } from "node:fs"; import * as Effect from "effect/Effect"; import { value } from "../src/value.ts"; it("bad original", async () => { appendFileSync(${JSON.stringify(marker)}, "run\\n"); expect(await Effect.runPromise(value())).toBe(2); });`);
    const result = yield* run({ ...config(root), warm: false, cold: false }, [replace(value, "Effect.succeed(1)", "Effect.succeed(3)", "wrong")]).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect((yield* fs.readFileString(marker)).trim().split("\n")).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);
});
