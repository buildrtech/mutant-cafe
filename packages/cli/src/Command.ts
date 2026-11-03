import { ConfigFile, MutantSource, Reporter, RunConfig, type BaselineFailed, type Mutant, type ProgramLoadError, type RunReport, type Scratch, type ScratchError, type TestRunner, type TestSpawnError } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { selectInDiff } from "./Diff.ts";
import { errorExitCode, reportExitCode } from "./ExitCode.ts";
import { makeReporter, mutantLine } from "./Reporter.ts";

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {}

export type Run = (config: RunConfig, mutants: ReadonlyArray<Mutant>) => Effect.Effect<RunReport,
  BaselineFailed | ScratchError | TestSpawnError | ProgramLoadError,
  MutantSource | Scratch | TestRunner | Reporter>;

const flags = {
  list: Flag.Boolean("list").pipe(Flag.withDefault(false)),
  inDiff: Flag.String("in-diff").pipe(Flag.optional),
  include: Flag.String("file").pipe(Flag.atLeast(0)),
  exclude: Flag.String("exclude").pipe(Flag.atLeast(0)),
  jobs: Flag.Int("jobs").pipe(Flag.optional),
  timeout: Flag.Finite("timeout").pipe(Flag.optional, Flag.withDescription("Absolute test timeout in seconds")),
  timeoutMultiplier: Flag.Finite("timeout-multiplier").pipe(Flag.optional),
  minimumTimeout: Flag.Finite("minimum-test-timeout").pipe(Flag.optional, Flag.withDescription("Minimum test timeout in seconds")),
  output: Flag.String("output").pipe(Flag.withDefault("mutants.out")),
  tsconfig: Flag.String("tsconfig").pipe(Flag.withDefault("tsconfig.json")),
};

export const makeCommand = (options: {
  readonly root: string;
  readonly run: Run;
  readonly onExit?: (code: number) => Effect.Effect<void>;
}) => Command.make("mutant-cafe", flags, (input) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(options.root);
  const configPath = path.join(root, "mutants.config.json");
  const fileConfig = (yield* fs.exists(configPath))
    ? yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ConfigFile))),
      Effect.mapError((error) => new UsageError({ message: `Invalid mutants.config.json: ${String(error)}` })),
    ) : {};
  const timeoutMs = Option.map(input.timeout, (seconds) => Math.ceil(seconds * 1000));
  const inDiff = Option.getOrUndefined(input.inDiff);
  const config = yield* Schema.decodeEffect(RunConfig)({
    root,
    tsconfig: input.tsconfig,
    include: input.include.length > 0 ? input.include : fileConfig.include ?? ["**/*.ts", "**/*.tsx"],
    exclude: input.exclude.length > 0 ? input.exclude : fileConfig.exclude ?? [],
    functionFilter: fileConfig.functionFilter ?? [],
    ...(inDiff === undefined ? {} : { inDiff }),
    jobs: Option.getOrElse(input.jobs, () => fileConfig.jobs ?? 1),
    ...(Option.isSome(timeoutMs) ? { timeoutMs: timeoutMs.value } : {}),
    timeoutMultiplier: Option.getOrElse(input.timeoutMultiplier, () => fileConfig.timeoutMultiplier ?? 5),
    minimumTimeoutMs: Option.match(input.minimumTimeout, { onNone: () => fileConfig.minimumTimeoutMs ?? 20_000, onSome: (seconds) => Math.ceil(seconds * 1000) }),
    neverTimeoutMs: 1_000,
    outDir: input.output,
  }).pipe(Effect.mapError((error) => new UsageError({ message: String(error) })));
  if (config.jobs < 1 || config.timeoutMultiplier <= 0 || config.minimumTimeoutMs <= 0 || (config.timeoutMs !== undefined && config.timeoutMs <= 0)) {
    return yield* new UsageError({ message: "Jobs and timeout values must be positive" });
  }
  const source = yield* MutantSource;
  const generated = yield* Stream.runCollect(source.generate(config));
  const mutants = inDiff === undefined ? generated : yield* selectInDiff({ root, diffPath: inDiff, mutants: generated });
  if (input.list) {
    for (const mutant of mutants) yield* Console.log(mutantLine(mutant));
    if (options.onExit !== undefined) yield* options.onExit(0);
    return;
  }
  const reporter = yield* makeReporter({ root, outDir: config.outDir, mutants });
  const report = yield* options.run(config, mutants).pipe(Effect.provideService(Reporter, reporter));
  yield* reporter.write(report);
  if (options.onExit !== undefined) yield* options.onExit(reportExitCode(report));
}));

// The executable's runtime supplies core services. No engine or runner package is
// imported here; the integration layer owns that choice.
export const runCli = Effect.fn("runCli")(function*(options: {
  readonly root: string;
  readonly args: ReadonlyArray<string>;
  readonly run: Run;
}) {
  const code = yield* Ref.make(0);
  const command = makeCommand({ ...options, onExit: (value) => Ref.set(code, value) });
  yield* Command.runWith(command, { version: "0.0.0" })(options.args).pipe(
    Effect.catch((error) => Effect.gen(function*() {
      yield* Console.error(String(error));
      yield* Ref.set(code, errorExitCode(error));
    })),
    Effect.catchDefect((defect) => Effect.gen(function*() {
      yield* Console.error(`Internal error: ${String(defect)}`);
      yield* Ref.set(code, 70);
    })),
  );
  return yield* Ref.get(code);
});
