import { describe, expect, it } from "@effect/vitest";
import { MutantSource, Reporter, Scratch, TestRunner, type Mutant, type RunConfig, type RunReport } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeMutantSource, makeTypeScriptOracle } from "../../engine/src/index.ts";
import { chooseMode } from "../src/Mode.ts";
import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";

const workspace = decodeURIComponent(new URL("../../../", import.meta.url).pathname).replace(/\/$/, "");
const fixture = `${workspace}/packages/runner/test/fixtures/warm`;
const parallel = `${workspace}/packages/runner/test/fixtures/parallel`;
const live = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(Layer.provideMerge(NodeServices.layer));
const config = (root: string, cold = false): RunConfig => ({
  root, cold, warm: !cold, tsconfig: "tsconfig.json", include: ["src/**/*.ts"], exclude: [], functionFilter: [],
  jobs: 1, timeoutMultiplier: 2, minimumTimeoutMs: 20_000, neverTimeoutMs: 1_000, outDir: "mutants.out"
});
const source = MutantSource.of({ notMutated: () => Effect.succeed([]), generate: () => Stream.empty,
  checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) });
const execute = (root: string, cold: boolean, mutants: ReadonlyArray<Mutant>, mutantSource = source) => runMutants(config(root, cold), Stream.fromIterable(mutants)).pipe(
  Effect.provideService(MutantSource, mutantSource),
  Effect.provideService(Reporter, { progress: () => Effect.void, write: () => Effect.void })
);
const percentiles = (report: RunReport) => {
  const times = report.results.filter(result => result.outcome !== "unviable" && result.outcome !== "unreliable").map(result => result.durationMs).sort((a, b) => a - b);
  const at = (fraction: number) => times[Math.max(0, Math.ceil(times.length * fraction) - 1)] ?? 0;
  return { p50: at(0.5), p90: at(0.9), max: at(1) };
};
const outcomes = (report: RunReport) => Object.fromEntries(report.results.map(result => [result.mutant.id, result.outcome]));
const replace = (file: string, original: string, from: string, text: string, id: string, genre: Mutant["genre"] = "EffectSucceed"): Mutant => {
  const startOffset = original.indexOf(from);
  if (startOffset < 0) throw new Error(`Missing mutation target ${from}`);
  return { id, file, functionName: id, returnType: "fixture", description: id, genre, synthetic: false,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    replacement: { startOffset, endOffset: startOffset + from.length, text } };
};
const stateMutants = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const value = yield* fs.readFileString(`${fixture}/src/value.ts`);
  const other = yield* fs.readFileString(`${fixture}/src/other.ts`);
  return [
    replace("src/value.ts", value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong"),
    replace("src/other.ts", other, "unused = () => true", "unused = () => false", "unrelated", "BooleanFlip"),
    replace("src/value.ts", value, "Effect.succeed(1)", "Effect.never", "never", "EffectNever"),
    replace("src/other.ts", other, "other = () => true", "other = () => false", "wrong-other", "BooleanFlip")
  ];
});

const parallelMutants = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const value = yield* fs.readFileString(`${parallel}/src/value.ts`);
  return [
    replace("src/value.ts", value, "Effect.succeed(1)", "Effect.succeed(2)", "wrong-first"),
    replace("src/value.ts", value, "unused = () => true", "unused = () => false", "unused-first", "BooleanFlip"),
    replace("src/value.ts", value, "Effect.succeed(1)", "Effect.never", "parallel-never", "EffectNever"),
    replace("src/value.ts", value, "unused = () => true", "unused = () => false", "unused-last", "BooleanFlip"),
    replace("src/value.ts", value, "Effect.succeed(1)", "Effect.succeed(3)", "wrong-last")
  ];
});

describe("warm Vitest proof (one scratch worker)", () => {
  for (const [name, root] of [
    ["tagged-errors", `${workspace}/fixtures/tagged-errors`],
    ["engine coverage", `${workspace}/packages/engine/test/fixtures/coverage`],
    ["slow/state/hang", fixture],
    ["parallel-eight", parallel]
  ] as const) {
    it.live(`compares every selected mutant id cold vs warm: ${name}`, () => Effect.gen(function* () {
      const engine = makeMutantSource(makeTypeScriptOracle());
      const mutants = root === fixture ? yield* stateMutants : root === parallel ? yield* parallelMutants : yield* Stream.runCollect(engine.generate(config(root)));
      expect(mutants.length).toBeGreaterThan(0);
      const start = yield* Clock.currentTimeMillis;
      const cold = yield* execute(root, true, mutants, root === fixture || root === parallel ? source : engine);
      const middle = yield* Clock.currentTimeMillis;
      const warm = yield* execute(root, false, mutants, root === fixture || root === parallel ? source : engine);
      const end = yield* Clock.currentTimeMillis;
      expect(outcomes(warm), JSON.stringify(warm.results.map(result => ({ id: result.mutant.id, output: result.output })))).toEqual(outcomes(cold));
      expect(warm.results.some(result => result.output?.includes("mutant-warm:selected:"))).toBe(true);
      const proof = { fixture: name, mutants: mutants.length, coldMs: middle - start, warmMs: end - middle, identical: true,
        cold: outcomes(cold), warm: outcomes(warm),
        workers: { cold: cold.baseline.testWorkers, warm: warm.baseline.testWorkers },
        concurrency: { cold: cold.baseline.testConcurrency, warm: warm.baseline.testConcurrency },
        files: Object.keys(warm.baseline.testDurations ?? {}).length,
        probes: { cold: cold.reachabilityProbes?.length ?? 0, warm: warm.reachabilityProbes?.length ?? 0 },
        hostRestarts: { cold: cold.hostRestarts, warm: warm.hostRestarts },
        poolResets: { cold: cold.poolResets, warm: warm.poolResets },
        cached: { cold: cold.results.filter(result => result.outcome === "untested" && result.testCommand.length === 0).length,
          warm: warm.results.filter(result => result.outcome === "untested" && result.testCommand.length === 0).length },
        coldStats: percentiles(cold), warmStats: percentiles(warm),
        coldDurations: cold.results.map(result => result.durationMs), warmDurations: warm.results.map(result => result.durationMs),
        budgets: warm.results.filter(result => result.mutant.genre === "EffectNever").map(result => ({ id: result.mutant.id, file: result.mutant.file, timeoutMs: result.timeoutMs, outerTimeoutMs: result.outerTimeoutMs, baseMs: result.hangBudgetBaseMs })) };
      yield* Console.log(`P6 ${JSON.stringify(proof)}`);
      const proofDir = process.env.MUTANT_CAFE_PROOF_DIR;
      if (proofDir) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(proofDir, { recursive: true });
        yield* fs.writeFileString(`${proofDir}/${name.replaceAll(/[^a-z-]/g, "-")}.json`, JSON.stringify({ ...proof,
          beforeMs: Math.ceil(warm.baseline.durationMs * 2), afterMs: warm.results.find(result => result.mutant.id === "never")?.timeoutMs }, null, 2));
      }
      if (root === parallel) {
        expect(warm.baseline.testConcurrency).toBe(2);
        expect(cold.baseline.testConcurrency).toBe(2);
        expect(Object.keys(warm.baseline.testDurations ?? {})).toHaveLength(8);
        expect(outcomes(warm)).toEqual({ "wrong-first": "caught", "unused-first": "missed", "parallel-never": "caught", "unused-last": "missed", "wrong-last": "caught" });
        const reverse = yield* execute(parallel, false, [...mutants].reverse());
        expect(outcomes(reverse)).toEqual(outcomes(warm));
      }
      if (root === fixture) {
        expect(outcomes(warm)).toEqual({ wrong: "caught", unrelated: "missed", never: "caught", "wrong-other": "caught" });
        const never = warm.results.find(result => result.mutant.id === "never")!;
        // Three 1.5 s tests run sequentially. The budget is per test, not 2 × 4.5 s.
        expect(never.timeoutMs).toBeGreaterThanOrEqual(3_000);
        expect(never.timeoutMs).toBeLessThan(3_500);
        expect(never.timeoutMs!).toBeLessThan(warm.baseline.durationMs);
        yield* Console.log(`P4 ${JSON.stringify({ beforeMs: Math.ceil(warm.baseline.durationMs * 2), afterMs: never.timeoutMs })}`);
      }
    }).pipe(Effect.provide(live)), 600_000);
  }

  it("chooses warm only with a clear, amortized baseline saving", () => {
    const sample = { coldMs: 1_000, warmMs: 500, warmStartupMs: 100, testFiles: 8, mutants: 100 };
    expect(chooseMode(sample)).toBe("warm");
    expect(chooseMode({ ...sample, warmMs: 950 })).toBe("cold");
    expect(chooseMode({ ...sample, mutants: 1 })).toBe("cold");
    expect(chooseMode({ ...sample, mutants: 3, coldStartupMs: 300, warmRunStartupMs: 50 })).toBe("warm");
    expect(chooseMode({ ...sample, warmMs: 1_100 })).toBe("cold");
  });

  it.live("applies its measured auto decision to the actual mutant run", () => Effect.gen(function* () {
    const report = yield* runMutants({ ...config(parallel), warm: false, cold: false }, Stream.fromIterable((yield* parallelMutants).slice(0, 2))).pipe(
      Effect.provideService(MutantSource, source), Effect.provideService(Reporter, { progress: () => Effect.void, write: () => Effect.void }));
    expect(report.baseline.calibration).toBeUndefined();
    expect(report.baseline.testableMutants).toBe(2);
    expect(report.baseline.runnerMode).toBe("cold");
    expect(outcomes(report)).toEqual({ "wrong-first": "caught", "unused-first": "missed" });
    expect(report.results[1]?.output?.includes("mutant-warm:selected:")).toBe(report.baseline.runnerMode === "warm");
    const proofDir = process.env.MUTANT_CAFE_PROOF_DIR;
    if (proofDir) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(proofDir, { recursive: true });
      yield* fs.writeFileString(`${proofDir}/auto-choice.json`, JSON.stringify({ mode: report.baseline.runnerMode, calibration: report.baseline.calibration, outcomes: outcomes(report) }, null, 2));
    }
  }).pipe(Effect.provide(live)), 40_000);

  it.live("bases the hang budget and allowance on selected clean-baseline files", () => Effect.gen(function* () {
    const item = (yield* stateMutants)[2]!;
    const test = "checks/selected.fixture.mjs";
    const calls: Array<{ outer: number; test: number | undefined }> = [];
    const report = yield* execute(fixture, false, [item]).pipe(
      Effect.provideService(Scratch, { acquire: () => Effect.succeed({ path: fixture, apply: () => Effect.void, revert: () => Effect.void }) }),
      Effect.provideService(TestRunner, {
        baseline: () => Effect.succeed({ durationMs: 40_000, testCommand: ["vitest"], startupMs: 100,
          testDurations: { [test]: 1_500, unrelated: 30_000 }, testFileDurations: { [test]: 1_500, unrelated: 30_000 }, testTimeouts: { [test]: 5000 }, testTimeoutDetails: { [`${test}::task`]: 5000 } }),
        runRelated: (_dir, _file, outer, timeout) => Effect.sync(() => {
          calls.push({ outer, test: timeout });
          return { status: "passed" as const, durationMs: 9_000, command: ["vitest"], output: "", testFiles: [test],
            testDurations: { [test]: 9_000 }, testTimeouts: { [test]: 20_000 }, testTimeoutDetails: { [`${test}::task`]: 20_000 } };
        })
      }));
    expect(calls.at(-1)).toEqual({ outer: 4_600, test: 3_000 });
    expect(report.results[0]?.hangBudgetBaseMs).toBe(1_500);
    expect(report.results[0]?.timeoutMs).toBe(3_000);
  }).pipe(Effect.provide(live)), 10_000);

  it.live("does not credit cancellation itself as a failed test", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const value = yield* fs.readFileString(`${parallel}/src/value.ts`);
    const block = replace("src/value.ts", value, "let calls = 0", "let calls = (() => { while (true) {} })()", "loading-block");
    const report = yield* runMutants({ ...config(parallel), timeoutMs: 1_500 }, Stream.make(block, (yield* parallelMutants)[0]!)).pipe(
      Effect.provideService(MutantSource, source), Effect.provideService(Reporter, { progress: () => Effect.void, write: () => Effect.void }));
    expect(outcomes(report)).toEqual({ "loading-block": "timeout", "wrong-first": "caught" });
  }).pipe(Effect.provide(live)), 30_000);

  it.live("records coverage never budgets from real test results", () => Effect.gen(function* () {
    const root = `${workspace}/packages/engine/test/fixtures/coverage`;
    const engine = makeMutantSource(makeTypeScriptOracle());
    const selected = (yield* Stream.runCollect(engine.generate(config(root)))).filter(mutant => mutant.genre === "EffectNever");
    const report = yield* execute(root, false, selected, engine);
    expect(report.results.length).toBeGreaterThan(0);
    const target = process.env.MUTANT_CAFE_BUDGET_PROOF;
    if (target) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(target, JSON.stringify({ baseline: report.baseline, budgets: report.results.map(result => ({
        id: result.mutant.id, timeoutMs: result.timeoutMs, outerTimeoutMs: result.outerTimeoutMs, baseMs: result.hangBudgetBaseMs, outcome: result.outcome, durationMs: result.durationMs
      })) }, null, 2));
    }
  }).pipe(Effect.provide(live)), 120_000);

  it.live("restores a different source file and isolates module state in both mutant orders", () => Effect.gen(function* () {
    const mutants = (yield* stateMutants).slice(0, 2);
    const forward = yield* execute(fixture, false, mutants);
    const backward = yield* execute(fixture, false, [...mutants].reverse());
    expect(outcomes(forward)).toEqual({ wrong: "caught", unrelated: "missed" });
    expect(outcomes(backward)).toEqual(outcomes(forward));
  }).pipe(Effect.provide(live)), 60_000);

  it.live("recovers from a blocked pool, then runs another mutant on a working instance", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${fixture}/src/value.ts`);
    const block = replace("src/value.ts", text, "Effect.succeed(1)", "Effect.sync(() => { while (true) {} })", "block", "EffectNever");
    const wrong = (yield* stateMutants)[0]!;
    const report = yield* execute(fixture, false, [block, wrong]);
    expect(outcomes(report)).toEqual({ block: "caught", wrong: "caught" });
    expect(report.results[1]?.output).toContain("mutant-warm:selected:");
  }).pipe(Effect.provide(live)), 60_000);

  it.live("restarts a crashed pool once, then keeps the rest of the run cold", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${fixture}/src/value.ts`);
    // This process is the fixture's own disposable Vitest worker.
    const crash = replace("src/value.ts", text, "Effect.succeed(1)", 'Effect.sync(() => process.kill(process.pid, "SIGKILL"))', "crash");
    const messages: string[] = [];
    const console = yield* Console.Console;
    const report = yield* execute(fixture, false, [crash, (yield* stateMutants)[0]!]).pipe(
      Effect.provideService(Console.Console, { ...console, warn: (...args) => { messages.push(args.join(" ")); } }));
    expect(messages.filter(message => message.includes("restarting once"))).toHaveLength(1);
    expect(messages.join("\n")).toContain("crashed twice");
    expect(outcomes(report)).toEqual({ crash: "caught", wrong: "caught" });
    expect(report.results[1]?.output).not.toContain("mutant-warm:selected:");
    const nextRun = yield* execute(fixture, false, [(yield* stateMutants)[0]!]);
    expect(nextRun.results[0]?.outcome).toBe("caught");
    expect(nextRun.results[0]?.output).toContain("mutant-warm:selected:");
  }).pipe(Effect.provide(live)), 60_000);

  for (const isolation of ["isolate: false", "poolOptions: { forks: { isolate: false } }", "--no-isolate"]) {
    it.live(`uses cold mode with a warning for ${isolation}`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* Scratch;
      const copy = yield* scratch.acquire(fixture);
      // This fixture must pass without isolation. The order tests above require
      // it deliberately; use independent checks for the fallback tests instead.
      yield* fs.writeFileString(`${copy.path}/checks/other.fixture.mjs`, 'import { it, expect } from "vitest"; import { other } from "../src/other.ts"; it("other", () => expect(other()).toBe(true));');
      yield* fs.writeFileString(`${copy.path}/vitest.config.ts`, `export default { test: { include: ["checks/*.fixture.mjs"], ${isolation === "--no-isolate" ? "" : isolation} } };`);
      if (isolation === "--no-isolate") yield* fs.writeFileString(`${copy.path}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest --no-isolate" } }));
      const messages: string[] = [];
      const console = yield* Console.Console;
      const report = yield* execute(copy.path, false, [(yield* stateMutants)[0]!]).pipe(
        Effect.provideService(Console.Console, { ...console, warn: (...args) => { messages.push(args.join(" ")); } }));
      expect(messages.join("\n")).toContain("isolate: false");
      expect(messages.join("\n")).toContain("using cold mode");
      expect(report.results[0]?.outcome).toBe("caught");
      expect(report.results[0]?.output).not.toContain("mutant-warm:selected:");
    }).pipe(Effect.scoped, Effect.provide(live)), 30_000);
  }
});
