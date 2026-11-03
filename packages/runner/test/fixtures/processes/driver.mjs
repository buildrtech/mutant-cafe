import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Scratch, TestRunner } from "@mutant-cafe/core";
import { ScratchLive } from "../../../src/Scratch.ts";
import { TestRunnerLive } from "../../../src/TestRunner.ts";
import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { execFileSync } from "node:child_process";

const [mode, scenario, proof] = process.argv.slice(2);
const fixture = fileURLToPath(new URL(".", import.meta.url));
const records = () => readFileSync(proof, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const alive = item => {
  try { return execFileSync("ps", ["-p", String(item.pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim() === item.birth; }
  catch { return false; }
};
const escaped = Effect.callback(resume => {
  const check = () => { if (records().some(item => item.kind === "escaped")) { observer.close(); resume(Effect.void); } };
  const observer = watch(proof, check);
  check();
  return Effect.sync(() => observer.close());
});
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directories = new Set();
  const tracked = { ...fs,
    makeTempDirectory: options => fs.makeTempDirectory(options).pipe(Effect.tap(directory => Effect.sync(() => { if (options?.prefix === "mutant-processes-") directories.add(directory); }))),
    remove: (directory, options) => Effect.gen(function* () {
      if (directories.has(directory)) appendFileSync(proof, yield* fs.readFileString(`${directory}/pids.jsonl`));
      return yield* fs.remove(directory, options);
    })
  };
  yield* Effect.scoped(Effect.gen(function* () {
    const scratch = yield* Scratch;
    const tests = yield* TestRunner;
    const dir = yield* scratch.acquire(fixture);
    yield* fs.writeFileString(`${dir.path}/vitest.config.ts`, `export default { test: { pool: "forks", maxWorkers: 1, include: ["checks/*.fixture.mjs"], env: { MUTANT_CAFE_PID_PROOF: ${JSON.stringify(proof)} } } };`);
    yield* tests.open(dir, mode === "cold", mode === "warm", 1);
    yield* tests.baseline(dir);
    const original = yield* fs.readFileString(`${dir.path}/src/value.ts`);
    const value = scenario === "busy" ? 0 : scenario === "crash" ? 3 : scenario === "worker-timeout" ? 4 : 2;
    const offset = original.indexOf("1");
    const mutant = { id: "process-cleanup", file: "src/value.ts", functionName: "value", returnType: "number", genre: "BooleanFlip", description: "process cleanup fixture", synthetic: false,
      span: { start: { line: 1, column: 1 }, end: { line: 1, column: original.trimEnd().length + 1 } }, replacement: { startOffset: offset, endOffset: offset + 1, text: String(value) } };
    yield* Effect.acquireUseRelease(dir.apply(mutant), () => Effect.gen(function* () {
      yield* tests.invalidate(dir, mutant.file);
      const run = tests.runRelated(dir, mutant.file, ["cancel", "sigint", "worker-timeout"].includes(scenario) ? 60_000 : 2500, scenario === "worker-timeout" ? 1000 : 60_000);
      if (scenario === "cancel") {
        const fiber = yield* run.pipe(Effect.forkChild);
        yield* escaped.pipe(Effect.timeout(10_000));
        yield* Fiber.interrupt(fiber);
      } else {
        const result = yield* run;
        if (scenario !== "sigint" && result.status !== (scenario === "crash" || scenario === "worker-timeout" ? "failed" : "timedOut")) throw new Error(`Unexpected fixture status: ${result.status}`);
      }
      const survivors = records().filter(alive);
      if (survivors.length) throw new Error(`Owned PIDs survived before the next mutant: ${survivors.map(item => item.pid).join(", ")}`);
      yield* dir.revert(mutant);
      yield* tests.invalidate(dir, mutant.file);
      const control = yield* tests.runRelated(dir, mutant.file, 10_000, 5000);
      if (control.status !== "passed") throw new Error(`Next-mutant control failed: ${control.status}`);
    }), () => dir.revert(mutant).pipe(Effect.andThen(() => tests.invalidate(dir, mutant.file)), Effect.orDie));
  }).pipe(Effect.provide(Layer.mergeAll(ScratchLive, TestRunnerLive)), Effect.provideService(FileSystem.FileSystem, tracked)));
  console.log("process-cleanup:finished");
});
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
