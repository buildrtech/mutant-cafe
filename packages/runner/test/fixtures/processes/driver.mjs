import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Scratch, TestRunner } from "@mutant-cafe/core";
import { ScratchLive } from "../../../src/Scratch.ts";
import { TestRunnerLive } from "../../../src/TestRunner.ts";
import { ProcessInspector } from "../../../src/ProcessTree.ts";
import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { execFileSync } from "node:child_process";

const [mode, scenario, proof] = process.argv.slice(2);
const fixture = fileURLToPath(new URL(".", import.meta.url));
const records = () => readFileSync(proof, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const alive = item => {
  try { return execFileSync("ps", ["-p", String(item.pid), "-o", "stat=,lstart="], { encoding: "utf8", timeout: 250, env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^(?!Z)\S+\s+/, "") === item.birth; }
  catch { return false; }
};
const observed = kind => Effect.callback(resume => {
  const check = () => { if (records().some(item => item.kind === kind)) { observer.close(); resume(Effect.void); } };
  const observer = watch(proof, check);
  check();
  return Effect.sync(() => observer.close());
});
const escaped = observed("escaped");
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directories = new Set();
  const rawInspector = yield* ProcessInspector;
  let delayCleanup = false; let delayed = false; let inspectionPasses = 0;
  let interruptTeardownMs; let workerTimeoutMs; let busyRunMs;
  const inspector = { inspect: args => delayCleanup && !delayed && inspectionPasses++ > 0 ? Effect.gen(function* () {
    delayed = true;
    appendFileSync(proof, JSON.stringify({ kind: "cleanup-stalled" }) + "\n");
    return yield* Effect.never;
  }) : rawInspector.inspect(args) };
  const tracked = { ...fs,
    makeTempDirectory: options => fs.makeTempDirectory(options).pipe(Effect.tap(directory => Effect.sync(() => { if (options?.prefix === "mutant-processes-") directories.add(directory); }))),
    remove: (directory, options) => Effect.gen(function* () {
      if (directories.has(directory)) appendFileSync(proof, yield* fs.readFileString(`${directory}/pids.jsonl`));
      return yield* fs.remove(directory, options);
    })
  };
  const metrics = yield* Effect.scoped(Effect.gen(function* () {
    const scratch = yield* Scratch;
    const tests = yield* TestRunner;
    const dir = yield* scratch.acquire(fixture);
    yield* fs.writeFileString(`${dir.path}/vitest.config.ts`, `export default { test: { pool: "forks", maxWorkers: 1, include: ["checks/*.fixture.mjs"], env: { MUTANT_CAFE_PID_PROOF: ${JSON.stringify(proof)} } } };`);
    yield* tests.open(dir, mode === "cold", mode === "warm", 1);
    const baseline = yield* tests.baseline(dir);
    const original = yield* fs.readFileString(`${dir.path}/src/value.ts`);
    const value = scenario === "busy" ? 0 : scenario === "crash" ? 3 : ["worker-timeout", "worker-timeout-interrupt"].includes(scenario) ? 4 : scenario === "normal" ? 5 : scenario === "unhandled" ? 6 : scenario === "minimal-env" ? 7 : 2;
    const offset = original.indexOf("1");
    const mutant = { id: "process-cleanup", file: "src/value.ts", functionName: "value", returnType: "number", genre: "BooleanFlip", description: "process cleanup fixture", synthetic: false,
      span: { start: { line: 1, column: 1 }, end: { line: 1, column: original.trimEnd().length + 1 } }, replacement: { startOffset: offset, endOffset: offset + 1, text: String(value) } };
    yield* Effect.acquireUseRelease(dir.apply(mutant), () => Effect.gen(function* () {
      yield* tests.invalidate(dir, mutant.file);
      const workerTimeout = ["worker-timeout", "worker-timeout-interrupt"].includes(scenario);
      const run = tests.runRelated(dir, mutant.file, ["cancel", "sigint", "worker-timeout", "worker-timeout-interrupt"].includes(scenario) ? 60_000 : 2500, workerTimeout ? 1000 : 60_000);
      if (scenario === "worker-timeout-interrupt") {
        delayCleanup = true;
        const fiber = yield* run.pipe(Effect.forkChild);
        yield* observed("cleanup-stalled").pipe(Effect.timeout(10_000));
        const started = performance.now();
        yield* Fiber.interrupt(fiber);
        interruptTeardownMs = performance.now() - started;
        if (interruptTeardownMs > 5000) throw new Error(`Interrupted worker-timeout teardown exceeded 5s: ${interruptTeardownMs} ms`);
      } else if (scenario === "cancel") {
        const fiber = yield* run.pipe(Effect.forkChild);
        yield* escaped.pipe(Effect.timeout(10_000));
        yield* Fiber.interrupt(fiber);
      } else {
        if (scenario === "busy") appendFileSync(proof, JSON.stringify({ kind: "busy-run-started" }) + "\n");
        const started = performance.now();
        const result = yield* (scenario === "worker-timeout" ? run.pipe(Effect.timeout(7000)) : run);
        if (scenario === "worker-timeout") workerTimeoutMs = performance.now() - started;
        if (scenario === "busy") {
          busyRunMs = performance.now() - started;
          appendFileSync(proof, JSON.stringify({ kind: "busy-run-completed", busyRunMs }) + "\n");
          if (busyRunMs >= 15_000) throw new Error(`Busy run and cleanup exceeded 15s: ${busyRunMs} ms`);
        }
        if (scenario !== "sigint" && result.status !== (["normal", "minimal-env"].includes(scenario) ? "passed" : ["crash", "worker-timeout", "unhandled"].includes(scenario) ? "failed" : "timedOut")) throw new Error(`Unexpected fixture status: ${result.status}; ${result.output}`);
        if (mode === "warm" && scenario !== "crash" && result.hostPid !== baseline.hostPid) throw new Error("Healthy warm instance was restarted");
      }
      const survivors = records().filter(item => !(mode === "warm" && item.kind === "ancestor") && alive(item));
      if (mode === "warm" && scenario !== "crash" && !records().some(item => item.kind === "ancestor" && alive(item))) throw new Error("The healthy warm host was discarded between mutants");
      if (survivors.length) throw new Error(`Owned PIDs survived before the next mutant: ${survivors.map(item => item.pid).join(", ")}`);
      yield* dir.revert(mutant);
      yield* tests.invalidate(dir, mutant.file);
      const control = yield* tests.runRelated(dir, mutant.file, 10_000, 5000);
      if (control.status !== "passed") throw new Error(`Next-mutant control failed: ${control.status}; ${control.output}`);
      if (mode === "warm" && scenario !== "crash" && control.hostPid !== baseline.hostPid) throw new Error("Next mutant lost the warm host");
    }), () => dir.revert(mutant).pipe(Effect.andThen(() => tests.invalidate(dir, mutant.file)), Effect.orDie));
    return { ...(yield* tests.stats), ...(interruptTeardownMs === undefined ? {} : { interruptTeardownMs }), ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }), ...(busyRunMs === undefined ? {} : { busyRunMs }) };
  }).pipe(Effect.provide(Layer.mergeAll(ScratchLive, TestRunnerLive)), Effect.provideService(FileSystem.FileSystem, tracked), Effect.provideService(ProcessInspector, inspector)));
  yield* fs.writeFileString(proof + ".summary.json", JSON.stringify(metrics));
  console.log("process-cleanup:finished");
});
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
