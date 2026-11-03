import { Reporter, ReportWriteError, RunReport, Mutant, type MutantResult, type NotMutated } from "@mutant-cafe/core";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { unifiedDiff } from "./UnifiedDiff.ts";
import { countsLine, markdownSummary } from "./Summary.ts";

export const mutantLine = (mutant: Mutant, root: string, path: Path.Path): string =>
  `${path.relative(root, path.resolve(root, mutant.file))}:${mutant.span.start.line}:${mutant.span.start.column}: ${mutant.description.replace(mutant.returnType, shortType(mutant.displayReturnType ?? mutant.returnType))} [${mutant.id}]`;

const shortType = (text: string): string => {
  const line = text.replace(/\s+/g, " ");
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
};

const outcomes = ["caught", "missed", "timeout", "unviable", "untested", "unreliable"] as const;
const jsonReport = Schema.encodeEffect(Schema.fromJsonString(RunReport));
const logText = (result: MutantResult): string => [
  ...("output" in result && typeof result.output === "string" ? [result.output] : []),
  ...result.diagnostics,
].join("\n");

export const makeReporter = Effect.fn("makeReporter")(function*(options: {
  readonly root: string;
  readonly outDir: string;
  readonly mutants: ReadonlyArray<Mutant>;
  readonly notMutated?: ReadonlyArray<NotMutated>;
  readonly selected?: number;
  readonly budgetSkipped?: number;
  readonly markdown?: {
    readonly gitRoot: string;
    readonly marker: string;
    readonly advisory: boolean;
    readonly stdout: boolean;
    readonly files: ReadonlyArray<string>;
  };
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(options.root, options.outDir);
  const started = yield* Clock.currentTimeMillis;
  const semaphore = yield* Semaphore.make(1);
  const results: MutantResult[] = [];
  let pendingError: ReportWriteError | undefined;
  let summarized = false;
  const writeError = (error: unknown) => new ReportWriteError({ path: dir, message: String(error) });
  const ids = new Set<string>();
  for (const mutant of options.mutants) {
    if (!/^[A-Za-z0-9_-]+$/.test(mutant.id) || ids.has(mutant.id)) return yield* writeError("Mutant ids must be unique safe filenames");
    ids.add(mutant.id);
  }
  yield* Effect.gen(function*() {
    // Rotating an ancestor would move the source tree. An unrelated output path
    // is allowed, but an old directory is removed only if it is our report.
    const relative = path.relative(dir, path.resolve(options.root));
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return yield* new ReportWriteError({ path: dir, message: "Output cannot be the project root or an ancestor" });
    }
    if (yield* fs.exists(dir)) {
      if (!(yield* fs.exists(path.join(dir, "mutants.json")))) return yield* writeError("Existing output is not a mutant report; choose another --output");
      if (yield* fs.exists(`${dir}.old`)) {
        if (!(yield* fs.exists(path.join(`${dir}.old`, "mutants.json")))) return yield* writeError("Previous output is not a mutant report; choose another --output");
        yield* fs.remove(`${dir}.old`, { recursive: true });
      }
      yield* fs.rename(dir, `${dir}.old`);
    }
    yield* fs.makeDirectory(path.join(dir, "diff"), { recursive: true });
    yield* fs.makeDirectory(path.join(dir, "logs"), { recursive: true });
  }).pipe(Effect.mapError(writeError));
  // Encode the actual core contract, not a second report shape.
  const encodedMutants = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Mutant)))(options.mutants).pipe(Effect.mapError(writeError));
  yield* fs.writeFileString(path.join(dir, "mutants.json"), encodedMutants).pipe(Effect.mapError(writeError));
  yield* fs.writeFileString(path.join(dir, "not-mutated.txt"), (options.notMutated ?? []).map(item => `${path.relative(options.root, item.file)}:${item.span?.start.line ?? 1}:${item.span?.start.column ?? 1}: ${item.functionName}: ${item.reason}\n`).join("")).pipe(Effect.mapError(writeError));
  yield* Effect.forEach(outcomes, (outcome) => fs.writeFileString(path.join(dir, `${outcome}.txt`), ""), { discard: true }).pipe(Effect.mapError(writeError));
  for (const mutant of options.mutants) {
    const original = yield* fs.readFileString(path.resolve(options.root, mutant.file)).pipe(Effect.mapError(writeError));
    yield* fs.writeFileString(path.join(dir, "diff", `${mutant.id}.diff`), unifiedDiff(original, original.slice(0, mutant.replacement.startOffset) + mutant.replacement.text + original.slice(mutant.replacement.endOffset), path.relative(options.root, path.resolve(options.root, mutant.file)).replaceAll("\\", "/"))).pipe(Effect.mapError(writeError));
  }
  const writeLists = (items: ReadonlyArray<MutantResult>) => Effect.forEach(outcomes, (outcome) => {
    const lines = items.filter((result) => result.outcome === outcome).map((result) => mutantLine(result.mutant, options.root, path));
    return fs.writeFileString(path.join(dir, `${outcome}.txt`), lines.length === 0 ? "" : lines.join("\n") + "\n");
  }, { discard: true });
  const service = Reporter.of({
    progress: (result) => semaphore.withPermit(Effect.gen(function*() {
      results.push(result);
      if (!options.markdown?.stdout) yield* Console.log(`${result.outcome} ${mutantLine(result.mutant, options.root, path)} (${result.durationMs}ms)`);
      yield* Effect.gen(function*() {
        if (!ids.has(result.mutant.id)) return yield* writeError("Progress result does not belong to this report");
        yield* writeLists(results);
        yield* fs.writeFileString(path.join(dir, "logs", `${result.mutant.id}.log`), logText(result));
      }).pipe(Effect.catch((error) => Effect.gen(function*() {
        if (pendingError === undefined) {
          pendingError = writeError(error);
          yield* Console.warn(`Report write failed: ${pendingError.message}`);
        }
      })));
    })),
    write: (report) => semaphore.withPermit(Effect.gen(function*() {
      if (pendingError !== undefined) return yield* pendingError;
      const counted: RunReport = { ...report, selected: options.selected ?? options.mutants.length,
        run: report.results.length, budgetSkipped: options.budgetSkipped ?? 0 };
      const encoded = yield* jsonReport(counted).pipe(Effect.mapError(writeError));
      yield* fs.writeFileString(path.join(dir, "outcomes.json.tmp"), encoded).pipe(Effect.mapError(writeError));
      yield* fs.rename(path.join(dir, "outcomes.json.tmp"), path.join(dir, "outcomes.json")).pipe(Effect.mapError(writeError));
      yield* writeLists(report.results).pipe(Effect.mapError(writeError));
      for (const result of report.results) {
        if (!ids.has(result.mutant.id)) return yield* writeError("Final result does not belong to this report");
        yield* fs.writeFileString(path.join(dir, "logs", `${result.mutant.id}.log`), logText(result)).pipe(Effect.mapError(writeError));
      }
      // The runner writes on completion or interrupt and the CLI writes again
      // as the owner of the final report; files are idempotent, the summary prints once.
      if (options.markdown !== undefined) {
        const markdown = markdownSummary({ ...options.markdown, root: options.root, path, report: counted, notMutated: options.notMutated?.length ?? 0 });
        for (const file of new Set(options.markdown.files)) {
          yield* fs.writeFileString(file, markdown).pipe(Effect.mapError(error => new ReportWriteError({ path: file, message: String(error) })));
        }
        if (!summarized && options.markdown.stdout) yield* Console.log(markdown);
      }
      if (summarized) return;
      summarized = true;
      if (report.results.some(result => result.outcome === "unreliable")) yield* Console.warn("Unreliable: the configured Vitest run cannot see all tests. See unreliable.txt and per-mutant diagnostics; these are not missed mutants.");
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      if (!options.markdown?.stdout) yield* Console.log(countsLine(counted, options.notMutated?.length ?? 0) + `; ${(elapsed / 1000).toFixed(2)}s`);
      if (options.markdown === undefined && report.failure !== undefined) yield* Console.warn(report.failure);
    })),
  });
  return service;
});

export const ReporterLive = (options: Parameters<typeof makeReporter>[0]) =>
  Layer.effect(Reporter, makeReporter(options));
