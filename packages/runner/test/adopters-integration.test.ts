import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MutantSource, Reporter, ReportWriteError, RunReport, type Mutant, type RunConfig } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";

// Integration proof: executes replacements. Use an approved mutation-test host.
const dependencies = decodeURIComponent(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url).pathname);
const live = Layer.mergeAll(ScratchLive, TestRunnerLive);
for (const mode of ["globalSetup", "small", "paired", "cold", "warm"] as const) it.live(`reports exactly one final auto decision matching outcomes.json (${mode})`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const console = yield* Console.Console;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-decision-" });
  yield* fs.symlink(dependencies, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module","scripts":{"test":"vitest run"}}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, '{"compilerOptions":{"noEmit":true},"include":["value.ts"]}');
  const original = "export const value = () => true;";
  yield* fs.writeFileString(`${root}/value.ts`, original);
  yield* fs.writeFileString(`${root}/value.test.ts`, 'import { expect, it } from "vitest"; import { value } from "./value.ts"; it("value", () => expect(value()).toBe(true));');
  yield* fs.writeFileString(`${root}/global-setup.mjs`, "export default () => {};");
  yield* fs.writeFileString(`${root}/vitest.config.ts`, `export default { test: { maxWorkers: 1, include: ["value.test.ts"]${mode === "globalSetup" ? ', globalSetup: ["./global-setup.mjs"]' : ""} } };`);
  const count = mode === "paired" ? 3 : 1;
  const mutants: Mutant[] = Array.from({ length: count }, (_, index) => ({ id: `wrong-${index}`, file: "value.ts", functionName: "value",
    returnType: "boolean", genre: "BooleanFlip", description: "replace value with false", synthetic: false,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: original.length } },
    replacement: { startOffset: original.indexOf("true"), endOffset: original.indexOf("true") + 4, text: "false" } }));
  const config: RunConfig = { root, cold: mode === "cold", warm: mode === "warm", tsconfig: "tsconfig.json", include: [], exclude: [], functionFilter: [],
    jobs: 1, timeoutMultiplier: 5, minimumTimeoutMs: 10_000, neverTimeoutMs: 1000, outDir: "mutants.out" };
  const warnings: string[] = [];
  const report = yield* runMutants(config, Stream.fromIterable(mutants)).pipe(
    Effect.provide(live),
    Effect.provideService(MutantSource, { generate: () => Stream.empty, notMutated: () => Effect.succeed([]), checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) }),
    Effect.provideService(Reporter, { progress: () => Effect.void, write: report => Schema.encodeEffect(Schema.fromJsonString(RunReport))(report).pipe(
      Effect.flatMap(json => fs.writeFileString(`${root}/outcomes.json`, json)),
      Effect.mapError(error => new ReportWriteError({ path: `${root}/outcomes.json`, message: String(error) }))) }),
    Effect.provideService(Console.Console, { ...console, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } })
  );
  const persisted = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/outcomes.json`));
  expect(report.results.map(result => result.outcome)).toEqual(Array.from({ length: count }, () => "caught"));
  const lines = warnings.filter(line => line.startsWith("Vitest auto mode:"));
  if (mode === "cold" || mode === "warm") expect(lines).toEqual([]);
  else {
    expect(lines).toEqual([`Vitest auto mode: ${persisted.baseline.runnerMode}; ${persisted.baseline.runnerModeReason}`]);
    expect(persisted.baseline.runnerModeReason).not.toContain("pending");
    if (mode === "globalSetup") {
      expect(persisted.baseline.runnerMode).toBe("cold");
      expect(persisted.baseline.runnerModeReason).toContain("globalSetup");
    }
    if (mode === "small") expect(persisted.baseline.runnerModeReason).toContain("small selection");
    if (mode === "paired") expect(persisted.baseline.calibration).toBeDefined();
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 90_000);
