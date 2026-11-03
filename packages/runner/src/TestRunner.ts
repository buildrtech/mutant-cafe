import { BaselineFailed, TestRunner, TestSpawnError, type ScratchDir, type TestRun, type SelectionIssue } from "@mutant-cafe/core";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import { preflight } from "./Preflight.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { openWarmRunner } from "./WarmRunner.ts";
import { reporterSource } from "./VitestHost.ts";

export const TestRunnerLive = Layer.effect(TestRunner, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let warmDisabled = false;
  const sessions = new Map<string, Effect.Success<ReturnType<typeof openWarmRunner>>>();
  const execute = Effect.fn("TestRunner.execute")(function* (dir: ScratchDir, args: ReadonlyArray<string>, timeoutMs?: number, testTimeoutMs?: number) {
    const session = sessions.get(dir.path);
    if (session !== undefined && !warmDisabled) {
      if (timeoutMs === undefined) yield* Console.error(`Baseline command: vitest run --reporter=default (warm Node API, cwd: ${dir.path})`);
      const run = yield* session.run(args[0] === "related" ? args[1] : undefined, timeoutMs, testTimeoutMs ?? (timeoutMs === undefined ? undefined : Math.max(1, Math.floor(timeoutMs / 2))));
      if (run !== undefined) return { ...run, exitCode: run.status === "passed" || run.status === "untested" ? 0 : 1 };
    }
    // Dependency directories are linked to the source checkout. Disable both
    // result and transform caches so Vitest cannot write through those links.
    // npx resolves the project's own vitest without a package manager's
    // install-state checks, which fail in a scratch copy at a new path.
    const reporterDir = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-vitest-" }).pipe(
      Effect.mapError((error) => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const reporter = path.join(reporterDir, "reporter.mjs");
    const marker = `mutant-cafe:${path.basename(reporterDir)}:`;
    // Vitest's reporter lifecycle is the machine-readable selection/progress
    // boundary. No human output parsing, and partial failures survive an outer kill.
    yield* fs.writeFileString(reporter, reporterSource(marker)).pipe(Effect.mapError((error) => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const command = ["npx", "--no", "vitest", ...args, "--reporter=default", `--reporter=${reporter}`, "--bail", "1",
      ...(timeoutMs === undefined ? [] : ["--testTimeout", String(testTimeoutMs ?? Math.max(1, Math.floor(timeoutMs / 2)))]),
      "--no-cache", "--no-fsModuleCache", "--maxWorkers=2"];
    // Keep diagnostics off stdout so GitHub output is a Markdown document.
    if (timeoutMs === undefined) yield* Console.error(`Baseline command: ${command.join(" ")} (cwd: ${dir.path})`);
    const started = yield* Clock.currentTimeMillis;
    const chunks: Array<string> = [];
    let exitCode = 1;
    const child = Effect.scoped(Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command[0]!, command.slice(1), {
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
    const output = chunks.join("");
    const failed = output.includes(marker + "failed");
    const selection = output.split("\n").find(line => line.includes(marker + "selected:"))?.split(marker + "selected:")[1];
    const selected = selection === undefined ? [] : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(selection).pipe(
      Effect.mapError(error => new TestSpawnError({ command, message: `Cannot decode Vitest selected files: ${String(error)}` })));
    const testDurations: Record<string, number> = {};
    const testTimeouts: Record<string, number> = {};
    for (const line of output.split("\n")) {
      const entry = line.split(marker + "duration:")[1];
      if (entry === undefined) continue;
      const timing = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ file: Schema.String, duration: Schema.Finite, timeout: Schema.Finite })))(entry).pipe(
        Effect.mapError(error => new TestSpawnError({ command, message: String(error) })));
      testDurations[timing.file] = Math.max(testDurations[timing.file] ?? 0, timing.duration);
      testTimeouts[timing.file] = Math.max(testTimeouts[timing.file] ?? 0, timing.timeout);
    }
    const run: TestRun = {
      status: failed ? "failed" : status === "passed" && output.includes(marker + "empty") ? "untested" : status,
      durationMs: ended - started, command, output,
      testsCollected: output.includes(marker + "collected"),
      testFiles: selected, testDurations, testTimeouts,
    };
    return { ...run, exitCode };
  }, Effect.scoped);
  return TestRunner.of({
    open: Effect.fn("TestRunner.open")(function* (dir: ScratchDir, cold: boolean) {
      if (cold || warmDisabled) return;
      const session = yield* openWarmRunner(dir, () => { warmDisabled = true; }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })));
      sessions.set(dir.path, session);
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        sessions.delete(dir.path);
        // The fallback belongs to this run, not to later runs sharing the layer.
        if (sessions.size === 0) warmDisabled = false;
      }));
    }),
    invalidate: (dir, file) => sessions.get(dir.path)?.invalidate(file) ?? Effect.void,
    baseline: Effect.fn("TestRunner.baseline")(function* (dir: ScratchDir, tsconfig?: string) {
      const unreliable: ReadonlyArray<SelectionIssue> = yield* preflight(dir.path, tsconfig).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.catch(error => Effect.succeed([{ kind: "warning" as const, reason: `Cannot verify runner selection: ${String(error)}` }])));
      for (const issue of unreliable) yield* Console.warn(`Warning (${issue.kind}): ${issue.reason}`);
      if (unreliable.some(issue => issue.kind === "runner")) {
        const command = ["npx", "--no", "vitest", "run", "--passWithNoTests"];
        yield* Console.warn(`Baseline command (not executed: unsupported runner): ${command.join(" ")}`);
        return { durationMs: 0, testCommand: command, unreliable };
      }
      const run = yield* execute(dir, ["run", "--passWithNoTests"]);
      if (run.status !== "passed" && run.status !== "untested") {
        return yield* Effect.fail(new BaselineFailed({ exitCode: run.exitCode, output: run.output, command: run.command }));
      }
      return { durationMs: run.durationMs, testCommand: run.command, unreliable, testDurations: run.testDurations, testTimeouts: run.testTimeouts };
    }),
    runRelated: Effect.fn("TestRunner.runRelated")(function* (dir: ScratchDir, file: string, timeoutMs: number, testTimeoutMs?: number) {
      const related = yield* execute(dir, ["related", file, "--run", "--passWithNoTests"], timeoutMs, testTimeoutMs);
      if (related.status !== "untested") return related;
      const remaining = Math.max(1, timeoutMs - related.durationMs);
      const full = yield* execute(dir, ["run", "--passWithNoTests"], remaining, testTimeoutMs);
      return { ...full, status: full.status === "passed" ? "untested" as const : full.status, durationMs: related.durationMs + full.durationMs,
        output: related.output + "\nFull-suite fallback:\n" + full.output };
    })
  });
}));
