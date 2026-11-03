import { TestSpawnError, type ScratchDir, type TestRun } from "@mutant-cafe/core";
import { createEffectActor, send, setupEffect } from "@xstate/effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node IPC (process.send) is not exposed by Effect's spawner.
import { spawn, type ChildProcess } from "node:child_process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { acquireProcessTree, type OwnedProcessTree } from "./ProcessTree.ts";
import { reporterSource, vitestHostSource, type ProbeOptions } from "./VitestHost.ts";

const Message = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("invalidated") }),
  Schema.Struct({ type: Schema.Literal("collected") }),
  Schema.Struct({ type: Schema.Literal("failed") }),
  Schema.Struct({ type: Schema.Literal("selected"), files: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("selection"), files: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("probeLoaded") }),
  Schema.Struct({ type: Schema.Literal("fallback"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("crash"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), status: Schema.Literals(["passed", "failed", "untested"]),
    testFiles: Schema.Array(Schema.String), testsCollected: Schema.Boolean,
    testDurations: Schema.Record(Schema.String, Schema.Finite), testTimeouts: Schema.Record(Schema.String, Schema.Finite), testWorkers: Schema.Int, testConcurrency: Schema.Int, testFileDurations: Schema.Record(Schema.String, Schema.Finite), firstTestStart: Schema.Finite, probeSupported: Schema.Boolean, probeLoaded: Schema.Boolean, cleanupRequired: Schema.Boolean, crashed: Schema.Boolean })
]);
type Message = typeof Message.Type;

// One pending request per scratch copy. IPC carries only parsed reporter data;
// stdout is diagnostic text, never an outcome parser for the warm adapter.
class Host {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly tree: OwnedProcessTree;
  readonly scope: Scope.Closeable;
  output = "";
  collected = false;
  failed = false;
  testFiles: ReadonlyArray<string> = [];
  private pending: { resolve: (value: Message) => void; reject: (error: Error) => void } | undefined;
  private startup: Promise<Message>;
  constructor(root: string, script: string, reporter: string, tree: OwnedProcessTree, scope: Scope.Closeable) {
    this.tree = tree;
    this.scope = scope;
    this.child = spawn(process.execPath, [script, reporter], {
      cwd: root, env: tree.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    if (this.child.pid) tree.addRoot(this.child.pid);
    this.startup = this.wait();
    this.child.stdout?.on("data", chunk => { this.output += String(chunk); });
    this.child.stderr?.on("data", chunk => { this.output += String(chunk); });
    this.child.on("message", value => {
      try {
        const message = Schema.decodeUnknownSync(Message)(value);
        if (message.type === "collected") { this.collected = true; return; }
        if (message.type === "failed") { this.failed = true; return; }
        if (message.type === "probeLoaded") return;
        if (message.type === "selected") { this.testFiles = message.files; return; }
        const pending = this.pending;
        this.pending = undefined;
        pending?.resolve(message);
      } catch (error) { this.pending?.reject(new Error(`Invalid warm reporter message: ${String(error)}`)); }
    });
    // @effect-diagnostics-next-line newPromise:off -- Promise bridge for the native IPC adapter, scoped by openWarmRunner.
    this.exited = new Promise<void>(resolve => this.child.once("close", () => {
      this.pending?.reject(new Error(`Vitest host exited: ${this.output.slice(-4000)}`));
      this.pending = undefined;
      resolve();
    }));
    this.child.on("error", error => { this.pending?.reject(error); this.pending = undefined; });
  }
  private wait() {
    // @effect-diagnostics-next-line newPromise:off -- One IPC reply, consumed by Effect.tryPromise at the service boundary.
    return new Promise<Message>((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  ready() { return this.startup; }
  request(message: object) {
    const response = this.wait();
    this.post(message);
    return response;
  }
  post(message: object) {
    if (this.child.connected) this.child.send(message, error => {
      if (error) this.pending?.reject(error);
    });
    else this.pending?.reject(new Error("Vitest host disconnected"));
  }
  close() { return Scope.close(this.scope, Exit.succeed(undefined)).pipe(Effect.andThen(this.tree.assertClean)); }
  grace() {
    const self = this;
    return Effect.gen(function* () {
      self.post({ type: "close" });
      const exited = Effect.promise(() => self.exited);
      // The scope's next finalizer kills and verifies the entire owned tree,
      // even when the host exited but an escaped grandchild retained its pipes.
      const result = yield* exited.pipe(Effect.timeout(500), Effect.result);
      if (result._tag === "Failure") yield* Effect.sync(() => {
        // Native ChildProcess still owns this handle; unlike a bare saved PID,
        // kill() cannot target a PID that was reaped and reused.
        self.child.kill("SIGKILL");
      });
    });
  }
}

// idle -> running -> cancelling -> (idle | restarting) -> idle
// Two crashes for one mutant: restarting -> failed -> cold (terminal).
const lifecycle = setupEffect({ schemas: { events: {
  RUN: Schema.Struct({}), DONE: Schema.Struct({}), CANCEL: Schema.Struct({}),
  RESTART: Schema.Struct({}), READY: Schema.Struct({}), FAIL: Schema.Struct({}), FALLBACK: Schema.Struct({})
} } }).createMachine({
  initial: "idle",
  on: { FAIL: { target: ".failed" }, FALLBACK: { target: ".cold" } },
  states: {
    idle: { on: { RUN: { target: "running" }, RESTART: { target: "restarting" } } },
    running: { on: { DONE: { target: "idle" }, CANCEL: { target: "cancelling" }, RESTART: { target: "restarting" } } },
    cancelling: { on: { DONE: { target: "idle" }, RESTART: { target: "restarting" } } },
    restarting: { on: { READY: { target: "idle" } } },
    failed: { on: { FALLBACK: { target: "cold" } } },
    cold: { type: "final" }
  }
});

export const openWarmRunner = Effect.fn("TestRunner.openWarm")(function* (dir: ScratchDir, onFallback: () => void) {
  const fs = yield* FileSystem.FileSystem;
  const parentScope = yield* Scope.Scope;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-warm-" });
  const script = `${temp}/host.mjs`;
  const reporter = `${temp}/reporter.mjs`;
  yield* fs.writeFileString(script, vitestHostSource);
  yield* fs.writeFileString(reporter, reporterSource("mutant-warm:"));
  const actor = yield* createEffectActor(lifecycle);
  let host: Host | undefined;
  const attempt = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn,
    catch: error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error) }) });
  const close = () => host === undefined ? Effect.void : host.close();
  yield* Effect.addFinalizer(() => close().pipe(Effect.orDie));
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.succeed(undefined))).pipe(Effect.provideService(Scope.Scope, parentScope));
    const tree = yield* acquireProcessTree().pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })));
    const active = new Host(dir.path, script, reporter, tree, scope);
    host = active;
    yield* Effect.addFinalizer(() => active.grace()).pipe(Effect.provideService(Scope.Scope, scope));
    const ready = yield* attempt(() => host!.ready()).pipe(Effect.timeout(30_000),
      Effect.mapError(error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })));
    if (ready.type !== "ready") {
      yield* Console.warn(`Warning: warm Vitest unavailable; using cold mode: ${"message" in ready ? ready.message : ready.type}`);
      yield* Effect.sync(onFallback);
      yield* send(actor, { type: "FALLBACK" });
      yield* close();
    }
  });
  const retire = Effect.gen(function* () {
    yield* send(actor, { type: "RESTART" });
    yield* close();
  });
  const restart = Effect.gen(function* () {
    yield* retire;
    yield* start;
    if (actor.getSnapshot().value !== "cold") yield* send(actor, { type: "READY" });
  });
  yield* start;
  const isCold = () => actor.getSnapshot().value === "cold";
  const invalidate = Effect.fn("Warm.invalidate")(function* (file: string) {
    if (isCold()) return;
    if (actor.getSnapshot().value === "restarting") {
      // The caller restored the source before invalidating. Do not initialize a
      // replacement's config while the timed-out mutation is still on disk.
      yield* start;
      if (!isCold()) yield* send(actor, { type: "READY" });
      return;
    }
    const result = yield* attempt(() => host!.request({ type: "invalidate", file })).pipe(Effect.timeout(1_000), Effect.result);
    // A fresh host has no stale transforms. Never return a dirty graph to the pool.
    if (result._tag === "Failure") yield* restart;
  });
  const run = Effect.fn("Warm.run")(function* (file: string | undefined, timeoutMs?: number, testTimeout?: number, probe?: ProbeOptions): Effect.fn.Return<TestRun | undefined, TestSpawnError> {
    if (isCold()) return undefined;
    const command = ["vitest", ...(file ? ["related", file, "--run"] : ["run"]), "--reporter=default"];
    for (let crash = 0; crash < 2; crash++) {
      yield* send(actor, { type: "RUN" });
      const active = host!;
      active.output = "";
      active.collected = false;
      active.failed = false;
      active.testFiles = [];
      const started = yield* Clock.currentTimeMillis;
      const pending = active.request({ type: "run", file, testTimeout, probe });
      const response = attempt(() => pending);
      const result = yield* (timeoutMs === undefined ? response : response.pipe(Effect.timeout(timeoutMs))).pipe(Effect.result);
      if (result._tag === "Success" && result.success.type === "result" && !result.success.crashed) {
        if (result.success.cleanupRequired) yield* retire;
        else yield* send(actor, { type: "DONE" });
        return { ...result.success, startupMs: result.success.firstTestStart > 0 ? Math.max(0, Math.ceil(result.success.firstTestStart - started)) : 0,
          command, output: active.output, durationMs: (yield* Clock.currentTimeMillis) - started };
      }
      if (result._tag === "Failure" && result.failure._tag === "TimeoutError") {
        const failedAtDeadline = active.failed;
        yield* send(actor, { type: "CANCEL" });
        // cancelCurrentRun waits for the test: enforce a separate recovery grace.
        active.post({ type: "cancel" });
        yield* attempt(() => pending).pipe(Effect.timeout(500), Effect.result);
        // Cancellation can leave a setsid child outside Vitest's pool. A clean
        // replacement is mandatory even if the cancellation RPC returned.
        yield* retire;
        return { status: failedAtDeadline ? "failed" : "timedOut", command, output: active.output, durationMs: (yield* Clock.currentTimeMillis) - started,
          testsCollected: active.collected, testFiles: active.testFiles };
      }
      if (crash === 0) {
        yield* Console.warn(`Warning: Vitest pool crashed; restarting once: ${result._tag === "Failure" ? String(result.failure) : "message" in result.success ? result.success.message : result.success.type}`);
        yield* restart;
      }
      else {
        yield* send(actor, { type: "FAIL" });
        yield* close();
        yield* Console.warn("Warning: Vitest pool crashed twice for one mutant; using cold mode for the rest of this run");
        yield* Effect.sync(onFallback);
        yield* send(actor, { type: "FALLBACK" });
      }
      if (isCold()) return undefined;
    }
    return undefined;
  }, effect => effect.pipe(Effect.onInterrupt(() => Effect.gen(function* () {
    yield* send(actor, { type: "CANCEL" });
    host?.post({ type: "cancel" });
    yield* close().pipe(Effect.orDie);
    // The owner is cancelling this lease; restore must not wait on its old RPC.
    yield* send(actor, { type: "FALLBACK" });
  }))));
  const disable = Effect.gen(function* () {
    yield* close();
    yield* send(actor, { type: "FALLBACK" });
  });
  const select = Effect.fn("Warm.select")(function* (file: string) {
    if (isCold()) return undefined;
    const result = yield* attempt(() => host!.request({ type: "select", file })).pipe(Effect.timeout(30_000), Effect.result);
    if (result._tag === "Success" && result.success.type === "selection") return result.success.files;
    yield* restart;
    return undefined;
  });
  return { run, invalidate, disable, select };
});
