import { BaselineFailed, TestRunner, TestSpawnError, type ScratchDir, type TestRun, type SelectionIssue, type Mutant } from "@mutant-cafe/core";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import { preflight } from "./Preflight.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolve the target Vitest API for an external setup module.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { openWarmRunner } from "./WarmRunner.ts";
import { reporterSource, type ProbeOptions } from "./VitestHost.ts";
import { acquireProcessTree } from "./ProcessTree.ts";
import { chooseMode, startupCost, type Calibration } from "./Mode.ts";

export const TestRunnerLive = Layer.effect(TestRunner, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let warmDisabled = false;
  const sessions = new Map<string, Effect.Success<ReturnType<typeof openWarmRunner>>>();
  const auto = new Map<string, { readonly startupMs: number; readonly mutants: number }>();
  const primers = new Map<string, TestRun>();
  const scopes = new Map<string, Scope.Scope>();
  const selectors = new Map<string, Effect.Success<ReturnType<typeof openWarmRunner>>>();
  let automaticMode: "pending" | "cold" | "warm" = "pending";
  let hostRestarts = 0;
  let poolResets = 0;
  const sessionOptions = { onRestart: () => { hostRestarts++; }, onPoolReset: () => { poolResets++; } };
  const execute = Effect.fn("TestRunner.execute")(function* (dir: ScratchDir, args: ReadonlyArray<string>, timeoutMs?: number, testTimeoutMs?: number, forceCold = false, probe?: ProbeOptions) {
    const session = sessions.get(dir.path);
    if (session !== undefined && !warmDisabled && !auto.has(dir.path) && !forceCold) {
      if (timeoutMs === undefined) yield* Console.error(`Baseline command: vitest run --reporter=default (warm Node API, cwd: ${dir.path})`);
      const run = yield* session.run(args[0] === "related" ? args[1] : undefined, timeoutMs, testTimeoutMs ?? (timeoutMs === undefined ? undefined : Math.max(1, Math.floor(timeoutMs / 2))), probe);
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
    yield* fs.writeFileString(reporter, reporterSource(marker, probe)).pipe(Effect.mapError((error) => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const command = ["npx", "--no", "vitest", ...args, "--reporter=default", `--reporter=${reporter}`, "--bail", "1",
      ...(timeoutMs === undefined ? [] : ["--testTimeout", String(testTimeoutMs ?? Math.max(1, Math.floor(timeoutMs / 2))), "--hookTimeout", String(testTimeoutMs ?? Math.max(1, Math.floor(timeoutMs / 2)))]),
      "--no-cache", "--no-fsModuleCache"];
    // Keep diagnostics off stdout so GitHub output is a Markdown document.
    if (timeoutMs === undefined) yield* Console.error(`Baseline command: ${command.join(" ")} (cwd: ${dir.path})`);
    const started = yield* Clock.currentTimeMillis;
    const owned = yield* acquireProcessTree().pipe(Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(error => new TestSpawnError({ command, message: String(error) })));
    const chunks: Array<string> = [];
    let exitCode = 1;
    const child = Effect.scoped(Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command[0]!, command.slice(1), {
        cwd: dir.path,
        env: owned.env,
        // Node's scoped spawner kills the detached process group, not just pnpm.
        detached: true,
        killSignal: "SIGKILL",
        forceKillAfter: "100 millis",
        stdin: "ignore"
      }));
      yield* Effect.sync(() => owned.addRoot(handle.pid));
      const collect = handle.all.pipe(Stream.decodeText(), Stream.runForEach((chunk) =>
        Effect.sync(() => { chunks.push(chunk); })));
      const [code] = yield* Effect.all([handle.exitCode.pipe(Effect.tap(() => owned.cleanup)), collect], { concurrency: "unbounded" });
      exitCode = code;
      return code === 0 ? "passed" as const : "failed" as const;
    }).pipe(Effect.onInterrupt(() => owned.cleanup)));
    const status = yield* (timeoutMs === undefined ? child : child.pipe(
      Effect.timeout(timeoutMs),
      Effect.catchTag("TimeoutError", () => Effect.succeed("timedOut" as const))
    )).pipe(Effect.mapError((error) => new TestSpawnError({ command, message: error.message })));
    yield* owned.cleanup;
    const ended = yield* Clock.currentTimeMillis;
    const output = chunks.join("");
    const failed = output.includes(marker + "failed");
    const selection = output.split("\n").find(line => line.includes(marker + "selected:"))?.split(marker + "selected:")[1];
    const selected = selection === undefined ? [] : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(selection).pipe(
      Effect.mapError(error => new TestSpawnError({ command, message: `Cannot decode Vitest selected files: ${String(error)}` })));
    const testDurations: Record<string, number> = {};
    const testFileDurations: Record<string, number> = {};
    let firstTestStart = 0;
    const testTimeouts: Record<string, number> = {};
    const testTimeoutDetails: Record<string, number> = {};
    for (const line of output.split("\n")) {
      const entry = line.split(marker + "duration:")[1];
      if (entry === undefined) continue;
      const timing = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ file: Schema.String, duration: Schema.Finite, timeout: Schema.Finite, key: Schema.String, start: Schema.Finite })))(entry).pipe(
        Effect.mapError(error => new TestSpawnError({ command, message: String(error) })));
      if (timing.start > 0) firstTestStart = firstTestStart ? Math.min(firstTestStart, timing.start) : timing.start;
      testDurations[timing.file] = Math.max(testDurations[timing.file] ?? 0, timing.duration);
      testTimeoutDetails[timing.key] = timing.timeout;
      testTimeouts[timing.file] = Math.max(testTimeouts[timing.file] ?? 0, timing.timeout);
    }
    for (const part of output.split(marker + "fileDuration:").slice(1)) {
      const timing = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ file: Schema.String, duration: Schema.Finite })))(part.split("\n")[0]!).pipe(
        Effect.mapError(error => new TestSpawnError({ command, message: String(error) })));
      testFileDurations[timing.file] = timing.duration;
    }
    const run: TestRun = {
      status: failed ? "failed" : status === "passed" && output.includes(marker + "empty") ? "untested" : status,
      durationMs: ended - started, command, output,
      testsCollected: output.includes(marker + "collected"),
      testFiles: selected, testDurations, testTimeouts, testTimeoutDetails, testFileDurations,
      startupMs: firstTestStart ? Math.max(0, Math.ceil(firstTestStart - started)) : 0,
      probeSupported: output.includes(marker + "probeSupported:true"),
      probeLoaded: output.includes(marker + "probeLoaded"),
      testWorkers: Number(output.split(marker + "workers:")[1]?.split("\n")[0] ?? 0),
      testConcurrency: Math.max(0, ...output.split(marker + "concurrency:").slice(1).map(part => Number(part.split("\n")[0]))),
    };
    return { ...run, exitCode };
  }, Effect.scoped);
  return TestRunner.of({
    stats: Effect.sync(() => ({ hostRestarts, poolResets })),
    open: Effect.fn("TestRunner.open")(function* (dir: ScratchDir, cold: boolean, warm = false, mutants = 1) {
      scopes.set(dir.path, yield* Scope.Scope);
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        sessions.delete(dir.path); selectors.delete(dir.path); auto.delete(dir.path); primers.delete(dir.path); scopes.delete(dir.path);
        if (scopes.size === 0) { warmDisabled = false; automaticMode = "pending"; hostRestarts = 0; poolResets = 0; }
      }));
      if (cold || warmDisabled || (!warm && automaticMode === "cold")) return;
      const started = yield* Clock.currentTimeMillis;
      const session = yield* openWarmRunner(dir, () => { warmDisabled = true; }, sessionOptions).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })));
      sessions.set(dir.path, session);
      if (warmDisabled || (!warm && automaticMode === "cold")) { yield* session.disable; return; }
      if (!warm && automaticMode === "pending") auto.set(dir.path, { startupMs: (yield* Clock.currentTimeMillis) - started, mutants });

    }),
    invalidate: (dir, file) => sessions.get(dir.path)?.invalidate(file) ?? Effect.void,
    selectRelated: Effect.fn("TestRunner.selectRelated")(function* (dir: ScratchDir, file: string) {
      const session = sessions.get(dir.path);
      if (session !== undefined && !warmDisabled) return yield* session.select(file);
      let selector = selectors.get(dir.path) ?? selectors.values().next().value;
      if (!selector) {
        const scope = scopes.get(dir.path);
        if (!scope) return undefined;
        selector = yield* openWarmRunner(dir, () => {}, { quiet: true }).pipe(Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Scope.Scope, scope), Effect.mapError(error => new TestSpawnError({ command: ["vitest", "select"], message: String(error) })));
        selectors.set(dir.path, selector);
      }
      return yield* selector.select(file);
    }),
    probeReachability: Effect.fn("TestRunner.probeReachability")(function* (dir: ScratchDir, mutant: Mutant, timeoutMs: number) {
      if (!dir.poison) return { file: mutant.file, status: "unsupported" as const, durationMs: 0, testCommand: [], output: "Scratch adapter cannot poison modules" };
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-probe-" });
      const signal = path.join(temporary, "loaded");
      const control = path.join(temporary, "control");
      const token = `mutant-cafe-probe:${path.basename(temporary)}`;
      const setupFile = path.join(temporary, "setup.mjs");
      const vitest = yield* Effect.try({ try: () => pathToFileURL(path.join(path.dirname(createRequire(path.join(dir.path, "package.json")).resolve("vitest/package.json")), "dist/index.js")).href,
        catch: error => new TestSpawnError({ command: ["vitest", "probe"], message: String(error) }) });
      yield* fs.writeFileString(setupFile, `import { beforeAll, afterAll } from ${JSON.stringify(vitest)};
        beforeAll(() => globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(control)}, "ready"));
        afterAll(() => { if (globalThis[Symbol.for(${JSON.stringify(token)})]) throw new Error(${JSON.stringify(token)}); });`);
      const started = yield* Clock.currentTimeMillis;
      const invalidate = () => sessions.get(dir.path)?.invalidate(mutant.file) ?? Effect.void;
      const run = yield* Effect.acquireUseRelease(
        dir.poison(mutant, signal, token),
        () => Effect.gen(function* () {
          yield* invalidate();
          return yield* execute(dir, ["run", "--passWithNoTests"], timeoutMs, undefined, false, { token, setupFile });
        }),
        () => dir.revert(mutant).pipe(Effect.andThen(invalidate), Effect.orDie)
      );
      const supported = yield* fs.exists(control);
      const loaded = (yield* fs.exists(signal)) || run.probeLoaded === true;
      return { file: mutant.file,
        status: !supported ? "unsupported" as const : run.status === "passed" && !loaded ? "unreachable" as const : "reachable" as const,
        durationMs: (yield* Clock.currentTimeMillis) - started, testCommand: run.command, output: run.output };
    }, effect => effect.pipe(Effect.scoped, Effect.mapError(error => error._tag === "ScratchError" || error._tag === "TestSpawnError" ? error :
      new TestSpawnError({ command: ["vitest", "probe"], message: String(error) })))),
    baseline: Effect.fn("TestRunner.baseline")(function* (dir: ScratchDir, tsconfig?: string) {
      const unreliable: ReadonlyArray<SelectionIssue> = yield* preflight(dir.path, tsconfig).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.catch(error => Effect.succeed([{ kind: "warning" as const, reason: `Cannot verify runner selection: ${String(error)}` }])));
      for (const issue of unreliable) yield* Console.warn(`Warning (${issue.kind}): ${issue.reason}`);
      if (unreliable.some(issue => issue.kind === "runner")) {
        const command = ["npx", "--no", "vitest", "run", "--passWithNoTests"];
        yield* Console.warn(`Baseline command (not executed: unsupported runner): ${command.join(" ")}`);
        return { durationMs: 0, testCommand: command, unreliable };
      }
      const run = yield* execute(dir, ["run", "--passWithNoTests"], undefined, undefined, auto.has(dir.path));
      if (run.status !== "passed" && run.status !== "untested") {
        return yield* Effect.fail(new BaselineFailed({ exitCode: run.exitCode, output: run.output, command: run.command }));
      }
      if (sessions.has(dir.path)) yield* sessions.get(dir.path)!.invalidate(run.testFiles?.[0] ?? "package.json");
      if (auto.has(dir.path)) primers.set(dir.path, run);
      return { durationMs: run.durationMs, testCommand: run.command, unreliable, hostPid: run.hostPid, testTimeoutDetails: run.testTimeoutDetails,
        testDurations: run.testDurations, testTimeouts: run.testTimeouts, testWorkers: run.testWorkers, testConcurrency: run.testConcurrency,
        testFileDurations: run.testFileDurations, startupMs: run.startupMs, probeSupported: run.probeSupported,
        runnerMode: sessions.has(dir.path) && !warmDisabled && !auto.has(dir.path) ? "warm" as const : "cold" as const };
    }),
    calibrate: Effect.fn("TestRunner.calibrate")(function* (dir: ScratchDir, mutants: number, copies: number) {
      const primer = primers.get(dir.path) ?? primers.values().next().value;
      if (!primer || automaticMode !== "pending" || auto.size === 0 || warmDisabled) return {};
      const disable = Effect.gen(function* () {
        automaticMode = "cold"; warmDisabled = true; auto.clear();
        for (const session of sessions.values()) yield* session.disable;
      });
      if (mutants <= (primer.testFiles?.length ?? 0)) {
        yield* disable;
        yield* Console.warn(`Vitest auto mode: cold; small selection (${mutants} testable mutants across ${primer.testFiles?.length ?? 0} files), skipping paired calibration`);
        return { runnerMode: "cold" as const, testableMutants: mutants };
      }
      // A successful primer warmed the filesystem for BOTH measured runs.
      const startups = [...auto.values()].map(entry => entry.startupMs);
      auto.clear();
      // Finish the cold process before warm global-setup services are started.
      const cold = yield* execute(dir, ["run", "--passWithNoTests"], undefined, undefined, true);
      if (cold.status !== "passed" && cold.status !== "untested") return yield* new BaselineFailed({ exitCode: cold.exitCode, output: cold.output, command: cold.command });
      const warm = yield* execute(dir, ["run", "--passWithNoTests"]);
      if (warm.status !== "passed" && warm.status !== "untested") return yield* new BaselineFailed({ exitCode: warm.exitCode, output: warm.output, command: warm.command });
      const calibration: Calibration = { coldMs: cold.durationMs, warmMs: warm.durationMs,
        warmStartupMs: startupCost(startups, copies),
        overheadMs: warm.durationMs + cold.durationMs, coldStartupMs: cold.startupMs ?? 0, warmRunStartupMs: warm.startupMs ?? 0, testFiles: cold.testFiles?.length ?? 0, mutants };
      const sameSelection = JSON.stringify([...(warm.testFiles ?? [])].sort()) === JSON.stringify([...(cold.testFiles ?? [])].sort());
      const choice = warm.status === cold.status && sameSelection ? chooseMode(calibration) : "cold";
      automaticMode = choice;
      auto.clear();
      yield* Console.warn(`Vitest auto mode: ${choice}; paired cold ${cold.durationMs} ms, warm ${warm.durationMs} ms; ${mutants} testable mutants, ${copies} copies, startup ${calibration.warmStartupMs} ms`);
      if (choice === "cold") yield* disable;
      else if (sessions.has(dir.path)) yield* sessions.get(dir.path)!.invalidate(warm.testFiles?.[0] ?? "package.json");
      const run = choice === "cold" ? cold : warm;
      return { runnerMode: choice, calibration, testableMutants: mutants, hostPid: run.hostPid };
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
