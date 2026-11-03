import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- External PID identity must be checked independently of the runner under test.
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Subscribe then read atomically at this native test-evidence boundary.
import { readFileSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/processes/", import.meta.url));
const Pid = Schema.Struct({ pid: Schema.Int, birth: Schema.String, kind: Schema.optional(Schema.String), pgid: Schema.optional(Schema.Int) });
type Pid = typeof Pid.Type;
const records = (proof: string): ReadonlyArray<Pid> => readFileSync(proof, "utf8").split("\n").flatMap(line => {
  const value = Schema.decodeOption(Schema.fromJsonString(Pid))(line);
  return value._tag === "Some" ? [value.value] : [];
});
const birth = (pid: number, field = "lstart") => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", field + "="], { encoding: "utf8", timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const alive = (item: Pid) => {
  const identity = /^(\S+)\s+(.+)$/.exec(birth(item.pid, "stat=,lstart"));
  return identity !== null && !identity[1]!.startsWith("Z") && identity[2] === item.birth;
};
const waitForEscape = (proof: string) => Effect.callback<void>(resume => {
  const check = () => { if (records(proof).some(item => item.kind === "escaped")) { observer.close(); resume(Effect.void); } };
  const observer = watch(proof, check);
  check(); // Subscribe before reading, so an early registration cannot be lost.
  return Effect.sync(() => observer.close());
});

// This suite executes mutant fixtures. Run on the assigned mutation host only.
for (const mode of ["cold", "warm"]) {
  for (const scenario of ["busy", "escaped", "worker-timeout", "normal", "minimal-env", "unhandled", "cancel", "crash", "sigint"]) {
    it.live(`${mode}: reaps owned PIDs after ${scenario}, including new sessions`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-pid-proof-" });
      const proof = `${directory}/pids.jsonl`;
      yield* fs.writeFileString(proof, "");
      // A failed proof must not itself leave the fixture's busy loops running.
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        for (const item of records(proof)) {
          if (item.pid === process.pid || !alive(item)) continue;
          try { process.kill(item.pid, "SIGKILL"); } catch { /* Already exited. Never signal a reused PID. */ }
        }
      }));
      const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [`${fixture}/driver.mjs`, mode, scenario, proof], {
        cwd: fixture, detached: true, killSignal: "SIGINT", forceKillAfter: "10 seconds", stdin: "ignore", stdout: "pipe", stderr: "inherit"
      }));
      const output: string[] = [];
      const collected = yield* handle.stdout.pipe(Stream.decodeText(), Stream.runForEach(chunk => Effect.sync(() => { output.push(chunk); })), Effect.forkChild);
      if (scenario === "sigint") {
        const driver: Pid = { pid: handle.pid, birth: birth(handle.pid) };
        yield* waitForEscape(proof).pipe(Effect.timeout(20_000));
        expect(alive(driver)).toBe(true);
        // Signal only our controller, not its group or tree: its own finalizers
        // must reap the workers and escaped grandchild.
        yield* Effect.sync(() => process.kill(handle.pid, "SIGINT"));
      }
      const code = yield* handle.exitCode.pipe(Effect.timeout(45_000));
      yield* Fiber.join(collected);
      if (scenario !== "sigint") {
        expect(code, output.join("")).toBe(0);
        const metrics = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ hostRestarts: Schema.Int, poolResets: Schema.Int })))(yield* fs.readFileString(proof + ".summary.json"));
        if (mode === "warm" && scenario !== "crash") { expect(metrics.hostRestarts).toBe(0); expect(metrics.poolResets).toBe(["busy", "escaped", "cancel"].includes(scenario) ? 1 : 0); }
      }
      expect(yield* handle.isRunning).toBe(false);
      const observed = records(proof);
      expect(observed.some(item => item.kind === "worker")).toBe(true);
      expect(observed.some(item => item.kind === undefined)).toBe(true); // Captured ownership ledgers, including replacement hosts.
      if (!["busy", "unhandled"].includes(scenario)) {
        const escaped = observed.filter(item => item.kind === "escaped");
        expect(escaped.length).toBeGreaterThan(0);
        expect(escaped.every(item => item.pgid === item.pid)).toBe(true);
      }
      expect(observed.filter(alive).map(item => item.pid)).toEqual([]);
      const artifact = process.env.MUTANT_CAFE_PROCESS_PROOF;
      if (artifact) yield* fs.writeFileString(`${artifact}-${mode}-${scenario}.json`, JSON.stringify({ mode, scenario, driverPid: handle.pid, code, observed }, null, 2));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 60_000);
  }
}
