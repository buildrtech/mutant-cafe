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
import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";

const workspace = decodeURIComponent(new URL("../../../", import.meta.url).pathname).replace(/\/$/, "");
const fixture = `${workspace}/packages/runner/test/fixtures/warm`;
const live = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(Layer.provideMerge(NodeServices.layer));
const config = (root: string, cold = false): RunConfig => ({
  root, cold, tsconfig: "tsconfig.json", include: ["src/**/*.ts"], exclude: [], functionFilter: [],
  jobs: 1, timeoutMultiplier: 2, minimumTimeoutMs: 20_000, neverTimeoutMs: 1_000, outDir: "mutants.out"
});
const source = MutantSource.of({ notMutated: () => Effect.succeed([]), generate: () => Stream.empty,
  checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) });
const execute = (root: string, cold: boolean, mutants: ReadonlyArray<Mutant>, mutantSource = source) => runMutants(config(root, cold), Stream.fromIterable(mutants)).pipe(
  Effect.provideService(MutantSource, mutantSource),
  Effect.provideService(Reporter, { progress: () => Effect.void, write: () => Effect.void })
);
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

describe("warm Vitest proof (one scratch worker)", () => {
  for (const [name, root] of [
    ["tagged-errors", `${workspace}/fixtures/tagged-errors`],
    ["engine coverage", `${workspace}/packages/engine/test/fixtures/coverage`],
    ["slow/state/hang", fixture]
  ] as const) {
    it.live(`compares every selected mutant id cold vs warm: ${name}`, () => Effect.gen(function* () {
      const engine = makeMutantSource(makeTypeScriptOracle());
      const mutants = root === fixture ? yield* stateMutants : yield* Stream.runCollect(engine.generate(config(root)));
      expect(mutants.length).toBeGreaterThan(0);
      const start = yield* Clock.currentTimeMillis;
      const cold = yield* execute(root, true, mutants, root === fixture ? source : engine);
      const middle = yield* Clock.currentTimeMillis;
      const warm = yield* execute(root, false, mutants, root === fixture ? source : engine);
      const end = yield* Clock.currentTimeMillis;
      expect(outcomes(warm), warm.results.find(result => result.mutant.id === "unrelated")?.output).toEqual(outcomes(cold));
      expect(warm.results.some(result => result.output?.includes("mutant-warm:selected:"))).toBe(true);
      const proof = { fixture: name, mutants: mutants.length, coldMs: middle - start, warmMs: end - middle, identical: true,
        cold: outcomes(cold), warm: outcomes(warm) };
      yield* Console.log(`P6 ${JSON.stringify(proof)}`);
      const proofDir = process.env.MUTANT_CAFE_PROOF_DIR;
      if (proofDir) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(proofDir, { recursive: true });
        yield* fs.writeFileString(`${proofDir}/${name.replaceAll(/[^a-z-]/g, "-")}.json`, JSON.stringify({ ...proof,
          beforeMs: Math.ceil(warm.baseline.durationMs * 2), afterMs: warm.results.find(result => result.mutant.id === "never")?.timeoutMs }, null, 2));
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
