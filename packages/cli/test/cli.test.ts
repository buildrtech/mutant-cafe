import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BaselineFailed, MutantSource, Reporter, Scratch, TestRunner, RunReport, type Mutant } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { expect } from "vitest";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { runCli, type Run } from "../src/Command.ts";
import { makeReporter } from "../src/Reporter.ts";
import { reportExitCode } from "../src/ExitCode.ts";
import { selectInDiff } from "../src/Diff.ts";

const mutant = (options: { file?: string; line?: number; id?: string } = {}): Mutant => ({
  id: options.id ?? "withdraw-missed", file: options.file ?? "account.ts", functionName: "withdraw", returnType: "boolean",
  genre: "BooleanFlip", description: "replace body with false", synthetic: false,
  span: { start: { line: options.line ?? 1, column: 1 }, end: { line: options.line ?? 1, column: 30 } },
  replacement: { startOffset: 0, endOffset: 0, text: "// mutant\n" },
});
const report = (root: string, mutants: ReadonlyArray<Mutant>): RunReport => ({
  schemaVersion: 1, tool: "mutant.cafe", root, baseline: { durationMs: 10, testCommand: ["vitest", "run"] }, timeoutMs: 20_000,
  results: mutants.map((mutant) => ({ mutant, outcome: "missed", durationMs: 5, testCommand: ["vitest", "related", mutant.file], diagnostics: [] })),
});
const missedRun: Run = (config, mutants) => Effect.gen(function*() {
  const reporter = yield* Reporter;
  const output = report(config.root, mutants);
  for (const result of output.results) yield* reporter.progress(result);
  return output;
});
const invoke = (root: string, args: ReadonlyArray<string>, mutants: ReadonlyArray<Mutant>, run: Run = missedRun) => runCli({ root, args, run }).pipe(
  Effect.provideService(MutantSource, { generate: () => Stream.fromIterable(mutants), checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) }),
  Effect.provideService(Scratch, { acquire: () => Effect.die("Unexpected scratch acquisition in CLI adapter test") }),
  Effect.provideService(TestRunner, { baseline: () => Effect.die("Unexpected baseline"), runRelated: () => Effect.die("Unexpected test spawn") }),
);
const project = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-" });
  yield* fs.writeFileString(`${root}/account.ts`, "export const isEmpty = () => true;\n");
  return root;
});

it.live("the real CLI reports three distinct missed mutants with root-relative clickable paths", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  const output = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-e2e-" });
  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [
    path.resolve(import.meta.dirname, "../src/bin.ts"), "--jobs", "2", "--output", path.join(output, "report")
  ], { cwd: root }));
  const [stdout, stderr, exit] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(handle.stdout)),
    Stream.mkString(Stream.decodeText(handle.stderr)),
    handle.exitCode
  ], { concurrency: "unbounded" });
  expect(Number(exit), stderr).toBe(2);
  const lines = (yield* fs.readFileString(path.join(output, "report/missed.txt"))).trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(new Set(lines).size).toBe(3);
  for (const line of lines) {
    expect(line).toMatch(/^src\/account\.ts:\d+:\d+: replace /);
    expect(stdout).toContain(line);
    expect(line).not.toContain(root);
  }
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(
    yield* fs.readFileString(path.join(output, "report/outcomes.json"))
  );
  expect(report.results.filter((result) => result.outcome === "caught")).toHaveLength(6);
  expect(report.results.every((result) => path.isAbsolute(result.mutant.file))).toBe(true);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 60_000);

it.effect("writes missed output, returns CI failure, and rotates the previous run", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const items = [mutant()];
  expect(yield* invoke(root, [], items)).toBe(2);
  expect(yield* fs.readFileString(`${root}/mutants.out/missed.txt`)).toContain("account.ts:1:1: replace body with false");
  const first = yield* fs.readFileString(`${root}/mutants.out/outcomes.json`);
  expect(JSON.parse(first).results[0].outcome).toBe("missed");
  expect(yield* invoke(root, [], [])).toBe(0);
  expect(yield* fs.readFileString(`${root}/mutants.out.old/outcomes.json`)).toBe(first);
  expect(yield* fs.readFileString(`${root}/mutants.out/missed.txt`)).toBe("");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("writes mutants before execution, and outcome lists and logs during progress", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const item = mutant();
  const reporter = yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  expect(JSON.parse(yield* fs.readFileString(`${root}/mutants.out/mutants.json`))).toHaveLength(1);
  expect(yield* fs.exists(`${root}/mutants.out/diff/${item.id}.diff`)).toBe(true);
  const base = report(root, [item]);
  const output = { ...base, results: base.results.map((result) => ({ ...result, output: "raw test output" })) };
  yield* reporter.progress(output.results[0]!);
  expect(yield* fs.readFileString(`${root}/mutants.out/missed.txt`)).toContain(item.description);
  expect(yield* fs.readFileString(`${root}/mutants.out/logs/${item.id}.log`)).toBe("raw test output");
  yield* reporter.write(output);
  expect(reportExitCode(output)).toBe(2);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("a real git diff of the fixture selects only mutants in the edited function", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-diff-" });
  const fixture = yield* fs.readFileString(path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors/src/account.ts"));
  yield* fs.writeFileString(`${root}/account.ts`, fixture);
  const git = (args: ReadonlyArray<string>) => Effect.gen(function*() {
    const handle = yield* ChildProcess.make("git", args, { cwd: root });
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));
    expect(Number(yield* handle.exitCode)).toBe(0);
    return text;
  });
  yield* git(["init", "--quiet"]);
  yield* git(["add", "account.ts"]);
  const edited = fixture.replace("balance: account.balance - amount", "balance: account.balance - amount - 1");
  yield* fs.writeFileString(`${root}/account.ts`, edited);
  const patch = yield* git(["diff", "--no-ext-diff", "--unified=3", "--", "account.ts"]);
  yield* fs.writeFileString(`${root}/edit.diff`, patch);
  const changedLine = edited.split("\n").findIndex((line) => line.includes("balance: account.balance - amount - 1")) + 1;
  const outsideLine = edited.split("\n").findIndex((line) => line.startsWith("export const isEmpty")) + 1;
  const inside = mutant({ line: changedLine, id: "inside" });
  const outside = mutant({ line: outsideLine, id: "outside" });
  const selected = yield* selectInDiff({ root, diffPath: "edit.diff", mutants: [inside, outside] });
  expect(selected.map((item) => item.id)).toEqual(["inside"]);
  expect(yield* invoke(root, ["--list", "--in-diff", "edit.diff"], [inside, outside])).toBe(0);
  expect(yield* fs.exists(`${root}/mutants.out`)).toBe(false);
  yield* fs.writeFileString(`${root}/account.ts`, fixture);
  expect(yield* invoke(root, ["--list", "--in-diff", "edit.diff"], [inside, outside])).toBe(5);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("malformed diffs exit 6 without running tests or creating reports", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  yield* fs.writeFileString(`${root}/bad.diff`, "--- a/account.ts\n+++ b/account.ts\n@@ -1,2 +1,1 @@\n+truncated\n");
  expect(yield* invoke(root, ["--in-diff", "bad.diff"], [mutant()], () => Effect.die("Must not execute"))).toBe(6);
  expect(yield* fs.exists(`${root}/mutants.out`)).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("flags win over config and timeout flags use seconds", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  yield* fs.writeFileString(`${root}/mutants.config.json`, JSON.stringify({ jobs: 2, include: ["from-config.ts"], exclude: ["skip.ts"], timeoutMultiplier: 3 }));
  const run: Run = (config, mutants) => Effect.sync(() => {
    expect(config.jobs).toBe(4);
    expect(config.include).toEqual(["a.ts", "b.ts"]);
    expect(config.exclude).toEqual(["skip.ts"]);
    expect(config.timeoutMs).toBe(1500);
    expect(config.minimumTimeoutMs).toBe(2500);
    expect(config.timeoutMultiplier).toBe(3);
    return report(config.root, mutants);
  });
  expect(yield* invoke(root, ["--jobs", "4", "--file", "a.ts", "--file", "b.ts", "--timeout", "1.5", "--minimum-test-timeout", "2.5"], [], run)).toBe(0);
  expect(yield* invoke(root, ["--jobs", "0"], [])).toBe(1);
  yield* fs.writeFileString(`${root}/mutants.config.json`, '{"jobs":"bad"}');
  expect(yield* invoke(root, ["--list"], [])).toBe(1);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("maps baseline failure, timeouts, unviable mutants and internal defects for CI", () => Effect.gen(function*() {
  const root = yield* project;
  const baselineFailure: Run = () => Effect.fail(new BaselineFailed({ exitCode: 1, output: "Failing original suite" }));
  expect(yield* invoke(root, [], [], baselineFailure)).toBe(4);
  const timeoutRun: Run = (config, mutants) => Effect.succeed({ ...report(config.root, mutants), results: report(config.root, mutants).results.map((result) => ({ ...result, outcome: "timeout" })) });
  expect(yield* invoke(root, [], [mutant()], timeoutRun)).toBe(3);
  const unviableRun: Run = (config, mutants) => Effect.succeed({ ...report(config.root, mutants), results: report(config.root, mutants).results.map((result) => ({ ...result, outcome: "unviable" })) });
  expect(yield* invoke(root, [], [mutant()], unviableRun)).toBe(0);
  expect(yield* invoke(root, [], [], () => Effect.die("Unexpected engine defect"))).toBe(70);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("buffers a progress write failure and surfaces ReportWriteError at final write", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const item = mutant();
  const reporter = yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  const output = report(root, [item]);
  // Turn logs into a file to force a real filesystem failure, not a mock.
  yield* fs.remove(`${root}/mutants.out/logs`, { recursive: true });
  yield* fs.writeFileString(`${root}/mutants.out/logs`, "blocked");
  yield* reporter.progress(output.results[0]!);
  const result = yield* Effect.result(reporter.write(output));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("ReportWriteError");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("does not erase unrelated files at an output or backup path", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  yield* fs.makeDirectory(`${root}/mutants.out`);
  yield* fs.writeFileString(`${root}/mutants.out/keep.txt`, "user work");
  expect(yield* invoke(root, [], [])).toBe(70);
  expect(yield* fs.readFileString(`${root}/mutants.out/keep.txt`)).toBe("user work");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("generated mutant patches apply cleanly to the original, including missing final newlines", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const original = "export const isEmpty = () => true;";
  yield* fs.writeFileString(`${root}/account.ts`, original);
  const startOffset = original.indexOf("true");
  const item = { ...mutant(), replacement: { startOffset, endOffset: startOffset + 4, text: "false" } };
  yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  const handle = yield* ChildProcess.make("git", ["apply", `mutants.out/diff/${item.id}.diff`], { cwd: root });
  expect(Number(yield* handle.exitCode)).toBe(0);
  expect(yield* fs.readFileString(`${root}/account.ts`)).toBe("export const isEmpty = () => false;");
  const selected = yield* selectInDiff({ root, diffPath: `mutants.out/diff/${item.id}.diff`, mutants: [item] });
  expect(selected.map((mutant) => mutant.id)).toEqual([item.id]);
  yield* fs.writeFileString(`${root}/account.ts`, "export const isEmpty = () => false;\n");
  expect(yield* invoke(root, ["--list", "--in-diff", `mutants.out/diff/${item.id}.diff`], [item])).toBe(5);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
