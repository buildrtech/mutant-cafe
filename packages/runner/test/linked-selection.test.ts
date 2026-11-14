import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MutantSource, Reporter, RunReport, TestRunner, type RunConfig } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Path from "effect/Path";
import { makeMutantSource, makeTypeScriptOracle } from "../../engine/src/index.ts";
import { runMutants, ScratchLive } from "../src/index.ts";
import { reportExitCode } from "../../cli/src/ExitCode.ts";

// Real compiler discovery and scratch copies, but a stub test backend. No
// replacement is imported, evaluated or executed, and no Vitest child runs.
for (const folder of ["vendor", ".vendor"] as const) for (const cold of [false, true]) it.live(`reports linked ${folder} candidates as not mutated (${cold ? "cold" : "auto"}, stub backend)`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "linked-selection-" }));
  yield* fs.makeDirectory(`${root}/${folder}/shared/node_modules`, { recursive: true });
  yield* fs.makeDirectory(`${root}/vendorish`);
  yield* fs.writeFileString(`${root}/.gitignore`, `${folder}/\n`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module"}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { noEmit: true }, include: [`${folder}/**/*.ts`, "vendorish/**/*.ts"] }));
  const original = "export const linked = (): boolean => true;";
  yield* fs.writeFileString(`${root}/${folder}/shared/value.ts`, original);
  yield* fs.writeFileString(`${root}/vendorish/value.ts`, "export const regular = (): boolean => true;");
  const child = yield* ChildProcess.make("git", ["-C", root, "init", "--quiet"], { stdin: "ignore" });
  const [code] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
  expect(Number(code)).toBe(0);
  const config: RunConfig = { root, tsconfig: "tsconfig.json", include: folder === "vendor" ? ["**/*.{ts,tsx}"] : [".vendor/**"],
    exclude: [], functionFilter: [], jobs: 1, cold, timeoutMultiplier: 5, minimumTimeoutMs: 1000, neverTimeoutMs: 500, outDir: "mutants.out" };
  const source = makeMutantSource(makeTypeScriptOracle());
  const candidates = yield* Stream.runCollect(source.generate(config));
  const local = (file: string) => path.isAbsolute(file) ? path.relative(root, file) : file;
  const linked = candidates.filter(candidate => local(candidate.file).startsWith(`${folder}/`));
  const regular = candidates.filter(candidate => local(candidate.file).startsWith("vendorish/"));
  expect(linked.length).toBeGreaterThan(0);
  if (folder === "vendor") expect(regular.length).toBeGreaterThan(0);
  else expect(regular).toHaveLength(0);
  const viability: string[] = []; const related: string[] = []; const calibrated: number[] = [];
  const stream = Stream.fromIterable(candidates.map(candidate => cold ? { ...candidate, file: local(candidate.file) } : candidate));
  const report = yield* runMutants(config, stream).pipe(Effect.provide(ScratchLive),
    Effect.provideService(MutantSource, { ...source, checkViable: candidate => Effect.sync(() => {
      const file = local(candidate.file);
      viability.push(file);
      expect(file.startsWith("vendorish/")).toBe(true);
      return { viable: true, diagnostics: [] };
    }) }),
    Effect.provideService(TestRunner, {
      baseline: () => Effect.succeed({ durationMs: 1, testCommand: [], probeSupported: true }),
      selectRelated: (_dir, file) => Effect.sync(() => { expect(file.startsWith("vendorish/")).toBe(true); return ["value.test.ts"]; }),
      probeReachability: () => Effect.die("No linked candidate may reach poisoning"),
      ...(cold ? {} : { calibrate: (_dir, count) => Effect.sync(() => { calibrated.push(count); return { testableMutants: count, runnerMode: "cold" as const, runnerModeReason: "Stub backend" }; }) }),
      runRelated: (dir, file) => Effect.gen(function* () {
        related.push(file);
        expect(file.startsWith("vendorish/")).toBe(true);
        expect(yield* fs.readFileString(`${dir.path}/${file}`).pipe(Effect.orDie)).toContain("false");
        return { status: "passed" as const, durationMs: 0, command: [], output: "" };
      })
    }),
    Effect.provideService(Reporter, { progress: () => Effect.void, write: report => Schema.encodeEffect(Schema.fromJsonString(RunReport))(report).pipe(
      Effect.flatMap(json => fs.writeFileString(`${root}/report.json`, json)), Effect.orDie) })
  );
  expect(report.failure).toBeUndefined();
  expect(reportExitCode(report)).toBe(folder === "vendor" ? 2 : 0);
  expect(report.results).toHaveLength(regular.length);
  expect(report.results.every(result => local(result.mutant.file).startsWith("vendorish/") && result.outcome === "missed")).toBe(true);
  expect(report.notMutated).toContainEqual({ file: `${root}/${folder}/shared/value.ts`, functionName: "linked", span: linked[0]!.span,
    reason: "Source is in a linked ignored tree; original files are not mutation targets" });
  expect(viability).toHaveLength(regular.length);
  expect(related).toHaveLength(regular.length);
  expect(calibrated).toEqual(cold ? [] : [regular.length]);
  const persisted = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/report.json`));
  expect(persisted.notMutated).toEqual(report.notMutated);
  expect(persisted.failure).toBeUndefined();
  expect(yield* fs.readFileString(`${root}/${folder}/shared/value.ts`)).toBe(original);
  expect(yield* fs.readFileString(`${root}/vendorish/value.ts`)).toBe("export const regular = (): boolean => true;");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
