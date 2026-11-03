import { describe, expect, it } from "@effect/vitest";
import { MutantSource, Reporter, Scratch, TestRunner, TestSpawnError, RunReport, type Mutant, type RunConfig } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { makeReporter } from "../../cli/src/Reporter.ts";
import { decodeWarmMessage, openWarmRunner } from "../src/WarmRunner.ts";
import { runInNewContext } from "node:vm";
import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";
import { chooseMode, startupCost } from "../src/Mode.ts";
import { warmPolicySource, workerDeathSource } from "../src/WarmPolicy.ts";
import { acquireProcessTree, ProcessInspector } from "../src/ProcessTree.ts";

const workspace = decodeURIComponent(new URL("../../../", import.meta.url).pathname).replace(/\/$/, "");
const live = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(Layer.provideMerge(NodeServices.layer));
const source = MutantSource.of({ notMutated: () => Effect.succeed([]), generate: () => Stream.empty, checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) });
const settings = (root: string): RunConfig => ({ root, warm: true, cold: false, tsconfig: "tsconfig.json", include: ["src/**/*.ts"], exclude: [], functionFilter: [], jobs: 1, timeoutMultiplier: 2, minimumTimeoutMs: 20_000, neverTimeoutMs: 1000, outDir: "mutants.out" });
const code = "export const value = () => 1;";
const mutant = (id: string, value: number): Mutant => ({ id, file: "src/value.ts", functionName: "value", returnType: "number", genre: "BooleanFlip", description: id, synthetic: false, span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, replacement: { startOffset: code.indexOf("1"), endOffset: code.indexOf("1") + 1, text: String(value) } });
const fixture = (test = 'import { it, expect } from "vitest"; import { value } from "../src/value.ts"; it("value", () => expect(value()).toBe(1));', options = "") => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "round-four-" });
  yield* fs.symlink(`${workspace}/fixtures/tagged-errors/node_modules`, `${root}/node_modules`);
  yield* fs.makeDirectory(`${root}/src`); yield* fs.makeDirectory(`${root}/checks`);
  yield* fs.writeFileString(`${root}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["src"] }));
  yield* fs.writeFileString(`${root}/vitest.config.ts`, `export default { test: { maxWorkers: 2, include: ["checks/*.mjs"], ${options} } };`);
  yield* fs.writeFileString(`${root}/src/value.ts`, code); yield* fs.writeFileString(`${root}/checks/value.mjs`, test);
  return root;
});
const reporter = Reporter.of({ progress: () => Effect.void, write: () => Effect.void });
const run = (config: RunConfig, candidates: ReadonlyArray<Mutant>) => runMutants(config, Stream.fromIterable(candidates)).pipe(Effect.provideService(MutantSource, source), Effect.provideService(Reporter, reporter));

describe("round four correctness gates", () => {
  it("refuses unverified versions, unsupported pools and unwritable private fields", () => {
    const policy = (version: string, ctx: object) => runInNewContext(warmPolicySource + "; warmRefusal(version, ctx)", { version, ctx });
    const context = () => ({ pool: undefined, cancelPromise: undefined, runningPromise: undefined, configOverride: {}, reporters: [], initializeGlobalSetup: () => {}, config: { pool: "forks" }, projects: [], watcher: { invalidates: new Set() }, vite: { transformRequest: () => {} } });
    expect(policy("5.1.0", context())).toBe(null);
    for (const version of ["6.0.0", "4.9.0"]) expect(policy(version, context())).toContain("unverified Vitest major");
    for (const pool of ["vmForks", "vmThreads", "workerd"]) expect(policy("5.1.0", { ...context(), config: { pool } })).toContain("unsupported warm pool");
    expect(policy("5.1.0", { ...context(), config: { browser: { enabled: true } } })).toContain("browser");
    const readonly = context(); Object.defineProperty(readonly, "pool", { writable: false });
    expect(policy("5.1.0", readonly)).toContain("private field: pool");
    const missing = context(); Reflect.deleteProperty(missing, "cancelPromise");
    expect(policy("5.1.0", missing)).toContain("private field: cancelPromise");
  });

  it("recognizes nested worker-exit diagnostics but not an ordinary rejection", () => {
    const died = (error: unknown) => runInNewContext(workerDeathSource + "; workerDied(error)", { error });
    for (const error of [{ message: "ordinary unhandled rejection" }, { message: "expected worker to have exited" }, { message: "Cloudflare worker aborted by signal" }, { name: "AssertionError", message: "expected Worker exited unexpectedly" }]) expect(died(error)).toBe(false);
    expect(died({ name: "worker exited test", result: { state: "passed" } })).toBe(false);
    expect(died({ tasks: [{ result: { errors: [{ message: "Worker exited unexpectedly with signal SIGKILL" }] } }] })).toBe(true);
    for (const error of [{ message: "Worker exited unexpectedly with signal SIGKILL" }, { name: "Error", message: "[vitest-pool]: Worker forks emitted error.", cause: { message: "Worker exited unexpectedly with signal SIGTERM" } }, { errors: [{ code: "ERR_WORKER_OUT_OF_MEMORY" }] }]) expect(died(error)).toBe(true);
  });

  it("does not charge already paid samples or opened-copy startup", () => {
    expect(startupCost([100, 400], 2)).toBe(0);
    expect(startupCost([100], 3)).toBe(200);
    expect(chooseMode({ coldMs: 1000, warmMs: 500, warmStartupMs: 0, overheadMs: 1_000_000, testFiles: 8, mutants: 1 })).toBe("warm");
  });

  it.live("keeps global-setup-import mutation maps identical in cold, forced warm and auto", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture('import { it, expect, inject } from "vitest"; it("initialized value", () => expect(inject("actual")).toBe(1));', 'globalSetup: ["./setup.mjs"],');
    yield* fs.writeFileString(`${root}/setup.mjs`, 'import { value } from "./src/value.ts"; export default project => { project.provide("actual", value()); };');
    const candidates = [mutant("wrong", 2), mutant("control", 1)];
    const cold = yield* run({ ...settings(root), cold: true, warm: false }, candidates);
    const warnings: string[] = []; const original = yield* Console.Console;
    const logger = { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } };
    const forced = yield* run({ ...settings(root), jobs: 2 }, candidates).pipe(Effect.provideService(Console.Console, logger));
    expect(warnings.filter(message => message.includes("warm Vitest unavailable"))).toHaveLength(1);
    expect(warnings.some(message => message.includes("globalSetup"))).toBe(true);
    warnings.length = 0;
    const auto = yield* run({ ...settings(root), warm: false }, candidates).pipe(Effect.provideService(Console.Console, logger));
    expect(warnings.filter(message => message.includes("warm Vitest unavailable"))).toEqual([]);
    const outcomes = (report: typeof cold) => report.results.map(result => [result.mutant.id, result.outcome]).sort();
    expect(outcomes(cold)).toEqual([["control", "missed"], ["wrong", "caught"]]);
    expect(outcomes(forced)).toEqual(outcomes(cold)); expect(outcomes(auto)).toEqual(outcomes(cold));
    expect(forced.baseline.runnerMode).toBe("cold"); expect(auto.baseline.runnerMode).toBe("cold");
    expect(forced.baseline.runnerModeReason).toContain("globalSetup"); expect(auto.baseline.runnerModeReason).toContain("globalSetup");
    expect(auto.baseline.calibration).toBeUndefined();
    expect(warnings.some(message => message.includes("unowned scratch-related"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(live)), 45_000);

  for (const [options, reason] of [['pool: "vmForks",', "vmForks"], ['isolate: false,', "isolate: false"]] as const) for (const warm of [true, false]) it.live(`${warm ? "forced warm" : "auto"} refuses ${reason} before calibration`, () => Effect.gen(function* () {
    const root = yield* fixture(undefined, options);
    const warnings: string[] = []; const original = yield* Console.Console;
    // Four mutants across one file would trigger paired calibration if allowed.
    const report = yield* run({ ...settings(root), warm }, [2, 3, 4, 5].map(value => mutant(`wrong-${value}`, value))).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
    expect(report.baseline.runnerMode).toBe("cold"); expect(report.results[0]?.outcome).toBe("caught");
    expect(warnings.filter(message => message.includes("warm Vitest unavailable"))).toHaveLength(warm ? 1 : 0);
    expect(report.baseline.runnerModeReason).toContain(reason); expect(report.baseline.calibration).toBeUndefined();
    expect(report.results.every(result => !result.output?.includes("mutant-warm:selected:"))).toBe(true);
    expect(warnings.some(message => message.includes("unowned scratch-related"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("keeps selection-only hosts read-only even when isolation is disabled", () => Effect.gen(function* () {
    const root = yield* fixture(undefined, "isolate: false,"); const scratch = yield* Scratch; const dir = yield* scratch.acquire(root);
    const selector = yield* openWarmRunner(dir, () => {}, { selectionOnly: true, quiet: true });
    expect((yield* selector.select("src/value.ts"))?.length).toBe(1);
    const result = yield* selector.run(undefined, 10_000).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") { expect(result.failure.kind).toBe("reporter"); expect(result.failure.message).toContain("Selection-only"); }
  }).pipe(Effect.scoped, Effect.provide(live)), 15_000);

  it.live("overlaps forced-mode viability with running tests at jobs two", () => Effect.gen(function* () {
    const firstRun = yield* Deferred.make<void>(); const root = yield* fixture();
    const report = yield* runMutants({ ...settings(root), jobs: 2 }, Stream.fromIterable([mutant("first", 2), mutant("second", 3)])).pipe(
      Effect.provideService(MutantSource, { ...source, checkViable: item => (item.id === "second" ? Deferred.await(firstRun) : Effect.void).pipe(Effect.as({ viable: true, diagnostics: [] })) }),
      Effect.provideService(Reporter, reporter),
      Effect.provideService(Scratch, { acquire: () => Effect.succeed({ path: root, apply: () => Effect.void, revert: () => Effect.void }) }),
      Effect.provideService(TestRunner, { baseline: () => Effect.succeed({ durationMs: 1, testCommand: ["vitest"] }), runRelated: () => Deferred.succeed(firstRun, undefined).pipe(Effect.as({ status: "passed" as const, command: ["vitest"], durationMs: 1, output: "" })) }));
    expect(report.results.map(result => result.outcome)).toEqual(["missed", "missed"]);
  }).pipe(Effect.scoped, Effect.provide(live)), 10_000);

  it.live("keeps inherited 5000ms defaults out of the deadline when timeout is ten seconds", () => Effect.gen(function* () {
    const root = yield* fixture(); const file = "checks/value.mjs"; const calls: Array<number | undefined> = [];
    const candidate = { ...mutant("never", 2), genre: "EffectNever" as const };
    const report = yield* runMutants({ ...settings(root), timeoutMs: 10_000 }, Stream.make(candidate)).pipe(
      Effect.provideService(MutantSource, source), Effect.provideService(Reporter, reporter),
      Effect.provideService(Scratch, { acquire: () => Effect.succeed({ path: root, apply: () => Effect.void, revert: () => Effect.void }) }),
      Effect.provideService(TestRunner, { baseline: () => Effect.succeed({ durationMs: 10, testCommand: ["vitest"], testDurations: { [file]: 1 }, testFileDurations: { [file]: 10 }, testTimeoutDetails: { task: 5000 } }),
        runRelated: (_dir, _file, _outer, timeout) => Effect.sync(() => { calls.push(timeout); return { status: "passed" as const, durationMs: 1, command: ["vitest"], output: "", testFiles: [file], testTimeoutDetails: { task: timeout ?? 5000 } }; }) }));
    expect(calls[0]).toBe(5001); expect(report.results[0]?.timeoutMs).toBe(2000); expect(report.results[0]?.outerTimeoutMs).toBe(2010);
  }).pipe(Effect.scoped, Effect.provide(live)), 10_000);

  it.live("warns about unowned scratch argv without treating it as ownership", () => Effect.gen(function* () {
    const warnings: string[] = []; const original = yield* Console.Console;
    const tree = yield* acquireProcessTree("/synthetic/scratch").pipe(Effect.provideService(ProcessInspector, { inspect: _args => Effect.succeed({ stdout: "2147483000 1 2147483000 S Tue Nov 3 00:00:00 2026 /synthetic/scratch/child\n" }) }));
    expect(yield* tree.reap([]).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }))).toBe("clean");
    expect(warnings.some(message => message.includes("unowned scratch-related process PIDs 2147483000") && message.includes("not signalled"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  for (const workers of [undefined, "50%"] as const) for (const cold of [true, false]) {
    it.live(`writes real outcomes with ${workers ?? "default"} workers under ${cold ? "cold" : "warm"}`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem; const root = yield* fixture();
      yield* fs.writeFileString(`${root}/vitest.config.ts`, `export default ${JSON.stringify({ test: { include: ["checks/*.mjs"], ...(workers === undefined ? {} : { maxWorkers: workers }) } })};`);
      const candidates = [mutant("wrong", 2)];
      const writer = yield* makeReporter({ root, outDir: "report", mutants: candidates });
      const warnings: string[] = []; const original = yield* Console.Console;
      yield* runMutants({ ...settings(root), cold, warm: !cold }, Stream.fromIterable(candidates)).pipe(Effect.provideService(MutantSource, source), Effect.provideService(Reporter, writer), Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
      expect(warnings.some(message => message.includes("unowned scratch-related"))).toBe(false);
      const saved = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/report/outcomes.json`));
      expect(saved.failure).toBeUndefined(); expect(saved.results[0]?.outcome).toBe("caught");
      expect(saved.results[0]?.backstopMs).toBeGreaterThanOrEqual(0);
      expect(saved.baseline.testWorkers === undefined || Number.isSafeInteger(saved.baseline.testWorkers)).toBe(true);
      if (saved.baseline.testWorkers === undefined) expect(saved.baseline.telemetryWarnings?.some(message => message.includes("testWorkers"))).toBe(true);
      if (!cold) { expect(saved.baseline.runnerMode).toBe("warm"); expect(saved.hostRestarts).toBe(0); }
    }).pipe(Effect.scoped, Effect.provide(live)), 30_000);
  }

  it.live("surfaces our invalid protocol without pool retry or cold fallback", () => Effect.gen(function* () {
    const root = yield* fixture(); const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${root}/vitest.config.ts`, `import fs from "node:fs"; export default { plugins: [{ name: "host-proof", configResolved() { fs.writeFileSync("host.pid", String(process.pid)); } }], test: { maxWorkers: 2, include: ["checks/*.mjs"] } };`);
    const scratch = yield* Scratch; const dir = yield* scratch.acquire(root);
    let fallback = false; const warnings: string[] = [];
    const session = yield* openWarmRunner(dir, () => { fallback = true; }, { warn: message => Effect.sync(() => { warnings.push(message); }), decodeMessage: value => decodeWarmMessage(typeof value === "object" && value !== null && Reflect.get(value, "type") === "result" ? { ...value, status: "our-bad-status" } : value) });
    const pid = Number(yield* fs.readFileString(`${dir.path}/host.pid`));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const original = yield* Console.Console;
    const result = yield* session.run(undefined, 10_000).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") { expect(result.failure.kind).toBe("reporter"); expect(result.failure.message).toContain("our-bad-status"); }
    expect(fallback).toBe(false); expect(warnings.some(message => message.includes("crashed"))).toBe(false);
    const state = yield* Effect.try({ try: () => process.kill(pid, 0), catch: error => new TestSpawnError({ command: ["host-pid-proof"], message: typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH" ? "gone" : "Cannot inspect host PID" }) }).pipe(Effect.result);
    expect(state._tag).toBe("Failure"); // before the surrounding test scope finalizes
    if (state._tag === "Failure") expect(state.failure.message).toBe("gone");
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it("keeps a valid verdict when worker telemetry is fractional or a percentage", () => {
    for (const testWorkers of [0.5, "50%", NaN]) {
      const decoded = decodeWarmMessage({ type: "result", status: "passed", testWorkers, testConcurrency: 1, testFiles: [], testsCollected: true, crashed: false, probeSupported: false, probeLoaded: false });
      expect(decoded.type).toBe("result");
      if (decoded.type === "result") { expect(decoded.status).toBe("passed"); expect(decoded.testWorkers).toBeUndefined(); expect(decoded.telemetryWarnings?.join(" ")).toContain("testWorkers"); }
    }
  });

  it.live("auto selects warm from measurements and uses it for the mutants", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem; const root = yield* fixture();
    // Controlled latency exercises the decision, not a performance claim.
    yield* fs.writeFileString(`${root}/vitest.config.ts`, 'if (!process.argv[1]?.endsWith("host.mjs")) await new Promise(resolve => setTimeout(resolve, 800)); export default { test: { maxWorkers: 2, include: ["checks/*.mjs"] } };');
    const warnings: string[] = []; const original = yield* Console.Console;
    const report = yield* run({ ...settings(root), warm: false }, [2, 3, 4, 5].map(number => mutant(`wrong-${number}`, number))).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
    expect(warnings.some(message => message.includes("unowned scratch-related"))).toBe(false);
    expect(report.baseline.runnerMode).toBe("warm"); expect(report.baseline.calibration).toBeDefined();
    expect(chooseMode(report.baseline.calibration!)).toBe("warm"); expect(report.baseline.calibration!.warmStartupMs).toBe(0);
    expect(report.results.every(result => result.outcome === "caught" && result.output?.includes("mutant-warm:selected:"))).toBe(true);
    expect(report.poolResets).toBe(0);
    expect(report.results.every(result => result.backstopMs !== undefined && result.backstopMs >= 0)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);
});
