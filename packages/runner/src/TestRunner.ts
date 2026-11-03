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

export const TestRunnerLive = Layer.effect(TestRunner, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execute = Effect.fn("TestRunner.execute")(function* (dir: ScratchDir, args: ReadonlyArray<string>, timeoutMs?: number) {
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
    yield* fs.writeFileString(reporter, `import { relative } from "node:path";
    export default class {
      files = 0;
      onTestRunStart(specifications) { this.files = specifications.length; console.log(${JSON.stringify(marker + "selected:")} + JSON.stringify(specifications.map(spec => relative(process.cwd(), spec.moduleId)))); }
      onTestModuleCollected() { console.log(${JSON.stringify(marker + "collected")}); }
      onTestCaseResult(test) { if (test.result().state === "failed") console.log(${JSON.stringify(marker + "failed")}); }
      onTestRunEnd() { if (this.files === 0) console.log(${JSON.stringify(marker + "empty")}); }
    }`).pipe(Effect.mapError((error) => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const command = ["npx", "--no", "vitest", ...args, "--reporter=default", `--reporter=${reporter}`, "--bail", "1",
      ...(timeoutMs === undefined ? [] : ["--testTimeout", String(Math.max(1, Math.floor(timeoutMs / 2)))]),
      "--no-cache", "--no-fsModuleCache"];
    if (timeoutMs === undefined) yield* Console.log(`Baseline command: ${command.join(" ")} (cwd: ${dir.path})`);
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
    const run: TestRun = {
      status: failed ? "failed" : status === "passed" && output.includes(marker + "empty") ? "untested" : status,
      durationMs: ended - started, command, output,
      testsCollected: output.includes(marker + "collected"),
      testFiles: selected,
    };
    return { ...run, exitCode };
  }, Effect.scoped);
  return TestRunner.of({
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
      return { durationMs: run.durationMs, testCommand: run.command, unreliable };
    }),
    runRelated: Effect.fn("TestRunner.runRelated")(function* (dir: ScratchDir, file: string, timeoutMs: number) {
      const related = yield* execute(dir, ["related", file, "--run", "--passWithNoTests"], timeoutMs);
      if (related.status !== "untested") return related;
      const remaining = Math.max(1, timeoutMs - related.durationMs);
      const full = yield* execute(dir, ["run", "--passWithNoTests"], remaining);
      return { ...full, status: full.status === "passed" ? "untested" as const : full.status, durationMs: related.durationMs + full.durationMs,
        output: related.output + "\nFull-suite fallback:\n" + full.output };
    })
  });
}));
