import {
  MutantSource, MutantResult, Reporter, Scratch, TestRunner,
  type Baseline, BaselineFailed, type Mutant,
  type ProgramLoadError, type ReportWriteError, type RunConfig, type RunReport,
  type ScratchDir, type ScratchError, type TestSpawnError
} from "@mutant-cafe/core";
import { createEffectActor, createEffectLogic, join, send, setupEffect } from "@xstate/effect";
import { types } from "xstate";
import * as Effect from "effect/Effect";
import * as Pool from "effect/Pool";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { unreliableFor } from "./Preflight.ts";

type RunError = BaselineFailed | ScratchError | TestSpawnError | ProgramLoadError | ReportWriteError;
// XState freezes plain context objects in development. A pool is a live
// resource, not immutable run data; keep its internals behind a class handle.
class ScratchPool {
  readonly value: Pool.Pool<ScratchDir, ScratchError>;
  constructor(value: Pool.Pool<ScratchDir, ScratchError>) { this.value = value; }
}
interface RunState {
  readonly baseline: Baseline;
  readonly timeoutMs: number;
  readonly failure: RunError | undefined;
  readonly pool: ScratchPool | undefined;
  readonly pending: ReadonlyArray<Mutant>;
  readonly results: ReadonlyArray<MutantResult>;
  readonly reported: boolean;
}

/** A separate actor owns each run. Its resources outlive invoked phase tasks. */
export const runMutants = Effect.fn("Runner.runMutants")(function* (
  config: RunConfig, mutants?: Stream.Stream<Mutant, ProgramLoadError>
) {
  const scratch = yield* Scratch;
  const tests = yield* TestRunner;
  const source = yield* MutantSource;
  const reporter = yield* Reporter;
  const scope = yield* Scope.Scope;
  const path = yield* Path.Path;
  const jobs = Math.max(1, Math.floor(config.jobs));
  const report = (state: RunState): RunReport => ({
    schemaVersion: 2, tool: "mutant.cafe", root: config.root,
    baseline: state.baseline, timeoutMs: state.timeoutMs, results: state.results,
    ...(state.failure === undefined ? {} : { failure: state.failure._tag === "BaselineFailed" ? `${state.failure._tag}: ${state.failure.command.join(" ")}\n${state.failure.output.slice(-8000)}` : String(state.failure) })
  });
  const capture = <A, R>(effect: Effect.Effect<A, RunError, R>) => Effect.result(effect);
  const copying = createEffectLogic(() => capture(Effect.gen(function* () {
    const pool = yield* Pool.make({ acquire: scratch.acquire(config.root), size: jobs }).pipe(
      Effect.provideService(Scope.Scope, scope));
    // Force the first acquisition in the copying phase. The pool owns the
    // tree; this short lease does not reserve a worker during later tests.
    yield* Effect.scoped(Pool.get(pool));
    return new ScratchPool(pool);
  })));
  const baselining = createEffectLogic(({ input }: { input: ScratchPool | undefined }) => capture(Effect.gen(function* () {
    if (input === undefined) return yield* Effect.die("Missing scratch pool");
    const baseline = yield* Effect.scoped(Effect.gen(function* () {
      const dir = yield* Pool.get(input.value);
      return yield* tests.baseline(dir, path.isAbsolute(config.tsconfig) ? path.relative(config.root, config.tsconfig) : config.tsconfig);
    }));
    return { baseline, timeoutMs: config.timeoutMs ?? Math.max(config.minimumTimeoutMs, Math.ceil(config.timeoutMultiplier * baseline.durationMs)) };
  })));
  const generating = createEffectLogic(() => capture(Stream.runCollect(mutants ?? source.generate(config))));
  const testing = createEffectLogic(({ input }: { input: {
    readonly state: RunState;
    readonly record: (result: MutantResult) => Effect.Effect<void>;
  } }) => capture(Effect.gen(function* () {
    const dirs = input.state.pool?.value;
    if (dirs === undefined) return yield* Effect.die("Missing scratch pool");
    // Measure the original related selection once per file before applying any
    // mutant. Slow unrelated tests must not manufacture a caught never mutant.
    const neverBudgets = new Map<string, number>();
    for (const mutant of input.state.pending) {
      if (mutant.genre !== "EffectNever" || neverBudgets.has(mutant.file) || unreliableFor(input.state.baseline, path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file).length > 0) continue;
      const measured = yield* Effect.scoped(Effect.gen(function* () {
        const dir = yield* Pool.get(dirs);
        return yield* tests.runRelated(dir, path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file, input.state.timeoutMs);
      }));
      if (measured.status === "failed" || measured.status === "timedOut") {
        return yield* new BaselineFailed({ exitCode: 1, output: measured.output, command: measured.command });
      }
      neverBudgets.set(mutant.file, Math.max(config.neverTimeoutMs, Math.ceil(measured.durationMs * config.timeoutMultiplier)));
    }
    yield* Stream.fromIterable(input.state.pending).pipe(
      Stream.mapEffect((mutant) => Effect.scoped(Effect.gen(function* () {
        const viability = yield* source.checkViable(mutant);
        if (!viability.viable) {
          const result: MutantResult = { mutant, outcome: "unviable", durationMs: 0, testCommand: [], diagnostics: viability.diagnostics };
          yield* input.record(result);
          yield* reporter.progress(result);
          return;
        }
        const localFile = path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file;
        const unreliable = unreliableFor(input.state.baseline, localFile);
        if (unreliable.length) {
          const result: MutantResult = { mutant, outcome: "unreliable", durationMs: 0, testCommand: input.state.baseline.testCommand, diagnostics: unreliable.map(issue => issue.reason) };
          yield* input.record(result);
          yield* reporter.progress(result);
          return;
        }
        const dir = yield* Pool.get(dirs);
        const run = yield* Effect.acquireUseRelease(
          dir.apply(mutant),
          () => tests.runRelated(dir, path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file, mutant.genre === "EffectNever" ? neverBudgets.get(mutant.file)! : input.state.timeoutMs),
          // A dirty directory must never return to the pool, even on cancel.
          () => dir.revert(mutant).pipe(Effect.orDie)
        );
        const selectedIssues = unreliableFor(input.state.baseline, localFile, run.testFiles);
        const result: MutantResult = {
          mutant,
          // A kill before collection proves nothing about whether tests noticed.
          outcome: selectedIssues.length ? "unreliable" : run.status === "timedOut" ? (mutant.genre === "EffectNever" && run.testsCollected ? "caught" : "timeout")
            : run.status === "failed" ? "caught" : run.status === "untested" ? "untested" : "missed",
          durationMs: run.durationMs,
          testCommand: run.command,
          diagnostics: selectedIssues.map(issue => issue.reason),
          ...(run.output === "" ? {} : { output: run.output })
        };
        yield* input.record(result);
        yield* reporter.progress(result);
      })), { concurrency: jobs }),
      Stream.runDrain
    );
  })));
  const reporting = createEffectLogic(({ input }: { input: RunState }) => capture(
    input.reported ? Effect.void : reporter.write(report(input))
  ));
  // copying -> baseline -> generating -> testing -> reporting -> done.
  // Domain failures travel as actor outputs; completed results are events so
  // interruption can report the machine's current state, not a task-local array.
  const machine = setupEffect({
    schemas: {
      context: types<RunState>(),
      events: { CANCEL: Schema.Struct({}), RESULT: Schema.Struct({ result: MutantResult }) }
    },
    actors: { copying, baselining, generating, testing, reporting }
  }).createMachine({
    context: {
      baseline: { durationMs: 0, testCommand: [] },
      timeoutMs: config.timeoutMs ?? config.minimumTimeoutMs,
      failure: undefined, pool: undefined, pending: [], results: [], reported: false
    },
    output: ({ context }) => context,
    initial: "copying",
    on: {
      CANCEL: { target: ".interrupted" },
      RESULT: ({ context, event }) => ({ context: { ...context, results: [...context.results, event.result] } })
    },
    states: {
      copying: { invoke: { src: "copying", onDone: ({ context, event }) => Result.isSuccess(event.output)
        ? { target: "baseline", context: { ...context, pool: event.output.success } }
        : { target: "failed", context: { ...context, failure: event.output.failure } } } },
      baseline: { invoke: {
        src: "baselining", input: ({ context }) => context.pool,
        onDone: ({ context, event }) => Result.isSuccess(event.output)
          ? { target: "generating", context: { ...context, ...event.output.success } }
          : { target: "reporting", context: { ...context, failure: event.output.failure,
            baseline: event.output.failure._tag === "BaselineFailed" ? { durationMs: 0, testCommand: event.output.failure.command } : context.baseline
          } }
      } },
      generating: { invoke: { src: "generating", onDone: ({ context, event }) => Result.isSuccess(event.output)
        ? { target: "testing", context: { ...context, pending: event.output.success } }
        : { target: "reporting", context: { ...context, failure: event.output.failure } } } },
      testing: { invoke: {
        src: "testing", input: ({ context, self }) => ({
          state: context,
          // Queue completion before progress can trigger CANCEL. The parent's
          // FIFO mailbox commits this result before handling that cancellation.
          record: (result) => send(self, { type: "RESULT", result })
        }),
        onDone: ({ context, event }) => ({ target: "reporting", context: {
          ...context, failure: Result.isFailure(event.output) ? event.output.failure : context.failure
        } })
      } },
      reporting: { invoke: {
        src: "reporting", input: ({ context }) => context,
        onDone: ({ context, event }) => ({ target: "done", context: {
          ...context, reported: Result.isSuccess(event.output), failure: Result.isFailure(event.output) ? event.output.failure : context.failure
        } })
      } },
      interrupted: { invoke: {
        src: "reporting", input: ({ context }) => context,
        onDone: ({ context, event }) => ({ target: "done", context: {
          ...context, reported: Result.isSuccess(event.output), failure: Result.isFailure(event.output) ? event.output.failure : context.failure
        } })
      } },
      failed: { type: "final" },
      done: { type: "final" }
    }
  });
  // Close the actor host before the outer pool scope. Stopping an invocation
  // requests interruption; host release waits for its process/revert finalizers.
  const state = yield* Effect.scoped(Effect.gen(function* () {
    const actor = yield* createEffectActor(machine);
    // Domain failures are task outputs; only unexpected actor defects reach join.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Domain errors are captured above.
    return yield* join(actor).pipe(Effect.orDie, Effect.onInterrupt(() => Effect.gen(function* () {
      yield* send(actor, { type: "CANCEL" });
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Wait for the partial report before releasing the actor host.
      yield* join(actor).pipe(Effect.orDie);
    })));
  }));
  if (state.failure !== undefined) return yield* state.failure;
  return report(state);
}, Effect.scoped);
