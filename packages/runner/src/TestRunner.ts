import { BaselineFailed, TestRunner, TestSpawnError, type ScratchDir, type TestRun } from "@mutant-cafe/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const TestRunnerLive = Layer.effect(TestRunner, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const execute = Effect.fn("TestRunner.execute")(function* (dir: ScratchDir, args: ReadonlyArray<string>, timeoutMs?: number) {
    // Dependency directories are linked to the source checkout. Disable both
    // result and transform caches so Vitest cannot write through those links.
    const command = ["pnpm", "exec", "vitest", ...args, "--no-cache", "--no-fsModuleCache"];
    const started = yield* Clock.currentTimeMillis;
    const chunks: Array<string> = [];
    let exitCode = 1;
    const child = Effect.scoped(Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("pnpm", command.slice(1), {
        cwd: dir.path,
        // Node's scoped spawner kills the detached process group, not just pnpm.
        detached: true,
        killSignal: "SIGKILL",
        forceKillAfter: "100 millis",
        stdin: "ignore"
      }));
      const collect = handle.all.pipe(Stream.decodeText(), Stream.runForEach((chunk) =>
        Effect.sync(() => { chunks.push(chunk); })));
      const [code] = yield* Effect.all([handle.exitCode, collect], { concurrency: "unbounded" });
      exitCode = code;
      return code === 0 ? "passed" as const : "failed" as const;
    }));
    const status = yield* (timeoutMs === undefined ? child : child.pipe(
      Effect.timeout(timeoutMs),
      Effect.catchTag("TimeoutError", () => Effect.succeed("timedOut" as const))
    )).pipe(Effect.mapError((error) => new TestSpawnError({ command, message: error.message })));
    const ended = yield* Clock.currentTimeMillis;
    const run: TestRun = { status, durationMs: ended - started, command, output: chunks.join("") };
    return { ...run, exitCode };
  });
  return TestRunner.of({
    baseline: Effect.fn("TestRunner.baseline")(function* (dir: ScratchDir) {
      const run = yield* execute(dir, ["run"]);
      if (run.status !== "passed") {
        return yield* Effect.fail(new BaselineFailed({ exitCode: run.exitCode, output: run.output }));
      }
      return { durationMs: run.durationMs, testCommand: run.command };
    }),
    runRelated: Effect.fn("TestRunner.runRelated")((dir: ScratchDir, file: string, timeoutMs: number) =>
      execute(dir, ["related", file, "--run", "--passWithNoTests"], timeoutMs))
  });
}));
