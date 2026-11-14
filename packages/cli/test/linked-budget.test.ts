import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Mutant, MutantList, MutantSource, RunReport, Scratch, TestRunner } from "@mutant-cafe/core";
import { makeMutantSource, makeTypeScriptOracle } from "@mutant-cafe/engine";
import { ScratchLive } from "@mutant-cafe/runner";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { runCli } from "../src/Command.ts";

// Real discovery, read-only scratch inspection and CLI reporting; stub run
// results only. Acquiring scratch or executing any test is forbidden here.
for (const mode of ["budget", "list", "all-linked"] as const) it.live(`excludes linked candidates before the CLI budget (${mode}, no execution)`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const console = yield* Console.Console;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "linked-budget-" }));
  const folder = mode === "all-linked" ? ".vendor" : "lib/vendor";
  yield* fs.makeDirectory(`${root}/${folder}/node_modules`, { recursive: true });
  yield* fs.makeDirectory(`${root}/src`);
  yield* fs.writeFileString(`${root}/.gitignore`, `${folder}/\n`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module"}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { noEmit: true }, include: [`${folder}/**/*.ts`, "src/*.ts"] }));
  yield* fs.writeFileString(`${root}/${folder}/value.ts`, "export const linked = (): boolean => true;");
  for (const name of ["a", "b"]) yield* fs.writeFileString(`${root}/src/${name}.ts`, `export const ${name} = (): boolean => true;`);
  const child = yield* ChildProcess.make("git", ["-C", root, "init", "--quiet"], { stdin: "ignore" });
  const [exit] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
  expect(Number(exit)).toBe(0);
  const logs: string[] = []; const errors: string[] = []; const executed: Mutant[] = [];
  const args = mode === "all-linked" ? ["--file", ".vendor/**"] : ["--max-mutants", "1", ...(mode === "list" ? ["--list", "--format", "json"] : [])];
  const code = yield* Effect.gen(function* () {
    const scratch = yield* Scratch;
    return yield* runCli({ root, args, run: (config, mutants) => Effect.sync(() => {
      expect(mode).toBe("budget");
      executed.push(...mutants);
      return { schemaVersion: 2 as const, tool: "mutant.cafe" as const, root: config.root,
        baseline: { durationMs: 0, testCommand: [] }, timeoutMs: 0,
        results: mutants.map(mutant => ({ mutant, outcome: "caught" as const, durationMs: 0, testCommand: [], diagnostics: [] })) };
    }) }).pipe(Effect.provideService(Scratch, { ...scratch, acquire: () => Effect.die("Pre-budget selection must not create scratch") }));
  }).pipe(Effect.provide(ScratchLive),
    Effect.provideService(MutantSource, makeMutantSource(makeTypeScriptOracle())),
    Effect.provideService(TestRunner, { baseline: () => Effect.die("No baseline for stub CLI selection"), runRelated: () => Effect.die("No test execution") }),
    Effect.provideService(Console.Console, { ...console, log: (...args: ReadonlyArray<unknown>) => { logs.push(args.join(" ")); }, error: (...args: ReadonlyArray<unknown>) => { errors.push(args.join(" ")); } }));
  expect(code).toBe(0);
  if (mode === "list") {
    const list = yield* Schema.decodeEffect(Schema.fromJsonString(MutantList))(logs.join("\n"));
    expect(list.counts).toEqual({ selected: 2, run: 0, budgetSkipped: 1 });
    expect(list.mutants).toHaveLength(1);
    expect(list.mutants[0]?.file).toBe(`${root}/src/a.ts`);
    expect(list.notMutated).toHaveLength(1);
    expect(executed).toEqual([]);
  } else {
    const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
    expect(report.notMutated).toHaveLength(1);
    expect(report.notMutated?.[0]?.reason).toContain("linked ignored tree");
    expect(yield* fs.readFileString(`${root}/mutants.out/not-mutated.txt`)).toContain(`${folder}/value.ts:1:`);
    const listed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Mutant)))(yield* fs.readFileString(`${root}/mutants.out/mutants.json`));
    expect(listed).toHaveLength(mode === "budget" ? 1 : 0);
    expect(yield* fs.readDirectory(`${root}/mutants.out/diff`)).toHaveLength(mode === "budget" ? 1 : 0);
    if (mode === "budget") {
      expect(executed.map(mutant => mutant.file)).toEqual([`${root}/src/a.ts`]);
      expect(report.selected).toBe(2); expect(report.run).toBe(1); expect(report.budgetSkipped).toBe(1);
      expect(logs.join("\n")).toContain("2 selected, 1 run, 1 budget-skipped");
    } else {
      expect(executed).toEqual([]);
      expect(report.selected).toBe(0); expect(report.run).toBe(0); expect(report.budgetSkipped).toBe(0);
      expect(report.baseline.durationMs).toBe(0);
      expect(errors.join("\n")).toContain("cause: linked ignored trees. Baseline skipped");
    }
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
