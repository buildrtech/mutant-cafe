import {
  MutantSource, Reporter, Scratch, TestRunner,
  type Baseline, type BaselineFailed, type Mutant, type MutantResult,
  type ProgramLoadError, type ReportWriteError, type RunConfig, type RunReport,
  type ScratchDir, type ScratchError, type TestSpawnError
} from "@mutant-cafe/core";
import { createEffectActor, createEffectLogic, join, send, setupEffect } from "@xstate/effect";
import * as Effect from "effect/Effect";
import * as Pool from "effect/Pool";
import * as Path from "effect/Path";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

type RunError = BaselineFailed | ScratchError | TestSpawnError | ProgramLoadError | ReportWriteError;

/** A separate actor owns each run. Its resources outlive invoked phase tasks. */
export const runMutants = Effect.fn("Runner.runMutants")(function* (
  config: RunConfig, mutants?: Stream.Stream<Mutant, ProgramLoadError>
) {
    const scratch = yield* Scratch;
    const tests = yield* TestRunner;
    const source = yield* MutantSource;
    const reporter = yield* Reporter;
    const scope = yield* Scope.Scope;
    const path = yield* Path.Path.pipe(Effect.provide(NodePath.layer));
    const jobs = Math.max(1, Math.floor(config.jobs));
    let baseline: Baseline = { durationMs: 0, testCommand: [] };
    let timeoutMs = config.timeoutMs ?? config.minimumTimeoutMs;
    let failure: RunError | undefined;
    let pool: Pool.Pool<ScratchDir, ScratchError> | undefined;
    let pending: ReadonlyArray<Mutant> = [];
    const results: Array<MutantResult> = [];
    let reported = false;
    const report = (): RunReport => ({ schemaVersion: 1, tool: "mutant.cafe", root: config.root, baseline, timeoutMs, results: [...results] });
    const capture = <A, R>(effect: Effect.Effect<A, RunError, R>) => effect.pipe(
      Effect.as(true),
      Effect.catch((error) => Effect.sync(() => { failure = error; return false; }))
    );
    const copying = createEffectLogic(() => capture(Effect.gen(function* () {
      pool = yield* Pool.make({ acquire: scratch.acquire(config.root), size: jobs }).pipe(
        Effect.provideService(Scope.Scope, scope));
      // Force the first acquisition in the copying phase. The pool owns the
      // tree; this short lease does not reserve a worker during later tests.
      yield* Effect.scoped(Pool.get(pool));
    })));
    const baselining = createEffectLogic(() => capture(Effect.gen(function* () {
      if (pool === undefined) return yield* Effect.die("Missing scratch pool");
      const dirs = pool;
      baseline = yield* Effect.scoped(Effect.gen(function* () {
        const dir = yield* Pool.get(dirs);
        return yield* tests.baseline(dir);
      }));
      timeoutMs = config.timeoutMs ?? Math.max(config.minimumTimeoutMs, Math.ceil(config.timeoutMultiplier * baseline.durationMs));
    })));
    const generating = createEffectLogic(() => capture(Effect.gen(function* () {
      pending = yield* Stream.runCollect(mutants ?? source.generate(config));
    })));
    const testing = createEffectLogic(() => capture(Effect.gen(function* () {
      if (pool === undefined) return yield* Effect.die("Missing scratch pool");
      const dirs = pool;
      yield* Stream.fromIterable(pending).pipe(
        Stream.mapEffect((mutant) => Effect.scoped(Effect.gen(function* () {
          const viability = yield* source.checkViable(mutant);
          if (!viability.viable) {
            const result: MutantResult = { mutant, outcome: "unviable", durationMs: 0, testCommand: [], diagnostics: viability.diagnostics };
            results.push(result);
            yield* reporter.progress(result);
            return;
          }
          const dir = yield* Pool.get(dirs);
          const run = yield* Effect.acquireUseRelease(
            dir.apply(mutant),
            () => tests.runRelated(dir, path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file, mutant.genre === "EffectNever" ? config.neverTimeoutMs : timeoutMs),
            // A dirty directory must never return to the pool, even on cancel.
            () => dir.revert(mutant).pipe(Effect.orDie)
          );
          const result: MutantResult = {
            mutant,
            // Effect.never is meant to hang: a test that waits on it and times out noticed the mutant.
            outcome: run.status === "timedOut" ? (mutant.genre === "EffectNever" ? "caught" : "timeout") : run.status === "failed" ? "caught" : "missed",
            durationMs: run.durationMs,
            testCommand: run.command,
            diagnostics: [],
            ...(run.output === "" ? {} : { output: run.output })
          };
          results.push(result);
          yield* reporter.progress(result);
        })), { concurrency: jobs }),
        Stream.runDrain
      );
    })));
    const reporting = createEffectLogic(() => capture(Effect.gen(function* () {
      if (!reported) {
        yield* reporter.write(report());
        reported = true;
      }
    })));
    // Tasks return success/failure as data. Domain errors do not leak into
    // XState's unknown actor-error channel; the caller receives them below.
    const machine = setupEffect({
      schemas: { events: { CANCEL: Schema.Struct({}) } },
      actors: { copying, baselining, generating, testing, reporting }
    }).createMachine({
      initial: "copying",
      on: { CANCEL: { target: ".interrupted" } },
      states: {
        copying: { invoke: { src: "copying", onDone: ({ event }) => ({ target: event.output ? "baseline" : "failed" }) } },
        baseline: { invoke: { src: "baselining", onDone: ({ event }) => ({ target: event.output ? "generating" : failure?._tag === "BaselineFailed" ? "baselineFailed" : "failed" }) } },
        generating: { invoke: { src: "generating", onDone: ({ event }) => ({ target: event.output ? "testing" : "reporting" }) } },
        testing: { invoke: { src: "testing", onDone: { target: "reporting" } } },
        reporting: { invoke: { src: "reporting", onDone: { target: "done" } } },
        interrupted: { invoke: { src: "reporting", onDone: { target: "done" } } },
        baselineFailed: { type: "final" },
        failed: { type: "final" },
        done: { type: "final" }
      }
    });
    // Close the actor host before the outer pool scope. Stopping an invocation
    // requests interruption; host release waits for its process/revert finalizers.
    yield* Effect.scoped(Effect.gen(function* () {
      const actor = yield* createEffectActor(machine);
      // Domain failures are task outputs; only unexpected actor defects reach join.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Domain errors are captured above.
      yield* join(actor).pipe(Effect.orDie, Effect.onInterrupt(() => Effect.gen(function* () {
        yield* send(actor, { type: "CANCEL" });
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Wait for the partial report before releasing the actor host.
        yield* join(actor).pipe(Effect.orDie);
      })));
    }));
    if (failure !== undefined) return yield* Effect.fail(failure);
    return report();
}, Effect.scoped);
