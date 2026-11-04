import { expect, it } from "@effect/vitest";
import { TestRunner } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestRunnerLive } from "../src/TestRunner.ts";
import { acquireProcessTree, inspectScratchCwd } from "../src/ProcessTree.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dependencies = decodeURIComponent(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url).pathname);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "startup-deadline-" });
  yield* fs.symlink(dependencies, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module"}');
  return root;
});

// These are real Node startup stalls, before Vitest or any test body runs.
for (const baseline of [false, true]) it.live(`bounds ${baseline ? "baseline selection" : "cold run"} startup and reaps the stalled process`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fixture;
  const proof = `${root}/startup.jsonl`;
  const trace = `${root}/trace.jsonl`;
  const tracked: FileSystem.FileSystem = { ...fs, writeFileString: (path, text, options) => fs.writeFileString(path, path.endsWith("/register.mjs")
    ? `process.env.MUTANT_CAFE_PROCESS_TRACE = ${JSON.stringify(trace)};\n` + text + `\nappendFileSync(${JSON.stringify(proof)}, JSON.stringify({ pid: process.pid }) + "\\n"); setInterval(() => {}, 1000); await new Promise(() => {});`
    : text, options) };
  const started = performance.now();
  yield* Effect.scoped(Effect.gen(function* () {
    const tests = yield* TestRunner;
    const dir = { path: root, apply: () => Effect.void, revert: () => Effect.void };
    if (baseline) {
      const result = yield* tests.baseline(dir, undefined, 2000).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("BaselineTimedOut");
        if (result.failure._tag === "BaselineTimedOut") { expect(result.failure.timeoutMs).toBe(2000); expect(result.failure.message).toContain("exceeded 2 seconds"); expect(result.failure.message).toContain("--baseline-timeout"); }
      }
    } else {
      const result = yield* tests.runRelated(dir, "value.ts", 2000);
      expect(result.status).toBe("timedOut");
      expect(result.output).toContain("including startup");
      expect(result.testsCollected).toBe(false);
    }
  }).pipe(Effect.provide(TestRunnerLive), Effect.provideService(FileSystem.FileSystem, tracked)));
  expect(performance.now() - started).toBeLessThan(15_000);
  const pids = (yield* fs.readFileString(proof)).trim().split("\n").map(line => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })))(line).pid);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    expect(alive(pid), `stalled startup PID ${pid} survived`).toBe(false);
  }
  const stages = yield* fs.readFileString(trace);
  expect(stages).toContain('"stage":"preload-ready"');
  expect(stages).not.toContain('"stage":"vitest-start"');
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

it.live("a never-replying birth helper cannot hold the preload or user entry indefinitely", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fixture;
  const trace = `${root}/trace.jsonl`;
  const tracked: FileSystem.FileSystem = { ...fs, writeFileString: (path, text, options) => fs.writeFileString(path, path.endsWith("/register.mjs")
    ? `process.env.MUTANT_CAFE_PROCESS_TRACE = ${JSON.stringify(trace)}; cp[Symbol.for("mutant.cafe.nativeExecFile")] = () => ({ kill() {}, unref() {}, stdout: { destroy() {} }, stderr: { destroy() {} } });\n` + text
    : text, options) };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = performance.now();
  const output = yield* Effect.scoped(Effect.gen(function* () {
    const tree = yield* acquireProcessTree();
    const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["--eval", 'process.stdout.write("entry-started")'], { env: tree.env, detached: true, stdin: "ignore", killSignal: "SIGKILL", forceKillAfter: "100 millis" }));
    const [text, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], { concurrency: "unbounded" });
    expect(code).toBe(0);
    return text;
  }).pipe(Effect.provideService(FileSystem.FileSystem, tracked), Effect.timeout(5000)));
  expect(output).toBe("entry-started");
  expect(performance.now() - started).toBeLessThan(6000);
  const stages = yield* fs.readFileString(trace);
  expect(stages).toContain('"stage":"ps-record-timeout"');
  expect(stages).toContain('"stage":"preload-ready"');
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 10_000);

if (process.platform === "darwin") it.live("nonblocking native cwd inspection still names the scratch directory", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fixture;
  const actual = yield* fs.realPath(root);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["--eval", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    cwd: root, stdin: "ignore", detached: true, killSignal: "SIGKILL", forceKillAfter: "100 millis"
  }));
  const ready = yield* handle.stdout.pipe(Stream.decodeText(), Stream.take(1), Stream.mkString);
  expect(ready).toContain("ready");
  const result = yield* inspectScratchCwd([handle.pid]);
  expect(result.stdout).toContain(`p${handle.pid}\n`);
  expect(result.stdout).toContain(`n${actual}\n`);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 10_000);
