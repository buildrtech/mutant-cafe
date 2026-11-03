import { TestSpawnError } from "@mutant-cafe/core";
import { createEffectActor, createEffectLogic, join, send, setupEffect } from "@xstate/effect";
import { types } from "xstate";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- OS process inspection and PID signals have no portable Effect service.
import { execFile } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Adapt the OS inspector's callback API at this boundary.
import { promisify } from "node:util";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Ownership labels must not collide across unrelated processes.
import { randomUUID } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NODE_OPTIONS --import needs a file URL, including paths with spaces.
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
export const ProcessInspector = Context.Reference<{
  readonly inspect: (args: ReadonlyArray<string>) => Effect.Effect<{ readonly stdout: string }, TestSpawnError>;
}>("mutant.cafe/ProcessInspector", { defaultValue: () => ({ inspect: args => Effect.tryPromise({
  try: () => execute("ps", [...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 5000, env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" } }),
  catch: () => new TestSpawnError({ command: ["ps"], message: "Cannot inspect owned test processes" })
}) }) });
const tokenKey = "MUTANT_CAFE_PROCESS_TOKEN";
const ledgerKey = "MUTANT_CAFE_PROCESS_LEDGER";
const preloadKey = "MUTANT_CAFE_PROCESS_PRELOAD";

// Record native children at spawn, not when their parent eventually exits.
// Updating builtin ESM exports also covers `import { spawn } from node:child_process`.
const preloadSource = `import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const inspect = cp.execFileSync;
const ledger = process.env.${ledgerKey};
const token = process.env.${tokenKey};
const preload = process.env.${preloadKey};
const birth = pid => {
  try { return inspect("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000, env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const record = pid => {
  if (!pid || !ledger) return;
  const started = birth(pid);
  if (started) try { appendFileSync(ledger, JSON.stringify({ pid, birth: started, phase: process.env.MUTANT_CAFE_PROCESS_PHASE }) + "\\n"); } catch {}
};
if (ledger && token && preload) {
record(process.pid);
const environment = node => {
  const env = { ...process.env };
  const ownImport = "--import=" + preload;
  const original = (env.NODE_OPTIONS || "").replaceAll(ownImport, "").trim();
  if (node && env.${ledgerKey} === ledger && env.${tokenKey} === token) env.NODE_OPTIONS = (original + " " + ownImport).trim();
  else if (original) env.NODE_OPTIONS = original;
  else delete env.NODE_OPTIONS;
  return env;
};
const options = (value, node) => value?.env !== undefined ? value : ({ ...value, env: environment(node) });
for (const name of ["spawn", "fork", "execFile", "exec"]) {
  const original = cp[name];
  const wrapped = function (...args) {
    const index = name === "exec" ? 1 : Array.isArray(args[1]) || (args[1] === undefined && args.length > 2) ? 2 : 1;
    const value = typeof args[index] === "object" && args[index] !== null ? args[index] : undefined;
    const node = name === "fork" ? (value?.execPath || process.execPath) === process.execPath : args[0] === process.execPath;
    if (typeof args[index] === "function") args.splice(index, 0, options(undefined, node));
    else args[index] = options(value, node);
    const child = original.apply(this, args);
    record(child.pid);
    return child;
  };
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const descriptors = Object.getOwnPropertyDescriptors(original);
  delete descriptors[custom];
  Object.defineProperties(wrapped, descriptors);
  if (name === "exec" || name === "execFile") Object.defineProperty(wrapped, custom, { value: (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = wrapped(...args, (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  } });
  cp[name] = wrapped;
}
syncBuiltinESMExports();
}
`;

const Record = Schema.Struct({ pid: Schema.Int, birth: Schema.String });
type Record = typeof Record.Type;
interface ProcessInfo extends Record { readonly ppid: number; readonly pgid: number; readonly state: string }
interface CleanupState {
  readonly pending: ReadonlyArray<ProcessInfo>;
  readonly round: number;
  readonly failure: string | undefined;
}

export const acquireProcessTree = Effect.fn("ProcessTree.acquire")(function* (scratch?: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectory({ prefix: "mutant-processes-" });
  const ledger = `${directory}/pids.jsonl`;
  const script = `${directory}/register.mjs`;
  const token = yield* Effect.sync(randomUUID);
  const url = pathToFileURL(script).href;
  yield* fs.writeFileString(ledger, "");
  yield* fs.writeFileString(script, preloadSource);
  const roots = new Set<number>();
  const command = ["vitest", "process-cleanup"];
  // Never include inspector output: it can contain environment values.
  const { inspect } = yield* ProcessInspector;
  const snapshot = Effect.gen(function* () {
    const result = yield* inspect(["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="]);
    const found = new Map<number, ProcessInfo>();
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid !== process.pid && !match[4]!.startsWith("Z")) found.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), state: match[4]!, birth: match[5]!.trim() });
    }
    return found;
  });
  const discover = (preserved: ReadonlySet<number>, retained: ReadonlyArray<Record>) => Effect.gen(function* () {
    const table = yield* snapshot;
    const keep = new Set(preserved);
    const subtrees = new Set(retained.filter(item => table.get(item.pid)?.birth === item.birth).map(item => item.pid));
    let keepAdded: boolean;
    do { keepAdded = false; for (const item of table.values()) if (subtrees.has(item.ppid) && !subtrees.has(item.pid)) { subtrees.add(item.pid); keepAdded = true; } } while (keepAdded);
    for (const pid of subtrees) keep.add(pid);
    const registered = yield* fs.readFileString(ledger).pipe(Effect.mapError(() => new TestSpawnError({ command, message: "Cannot read the test process ownership ledger" })));
    const owned = new Set<number>();
    const uncertain = new Set<number>();
    for (const line of registered.split("\n")) {
      if (!line) continue;
      const parsed = Schema.decodeOption(Schema.fromJsonString(Record))(line);
      if (parsed._tag === "Some" && table.get(parsed.value.pid)?.birth === parsed.value.birth) owned.add(parsed.value.pid);
    }
    // A child may have daemonized and lost its PPID before cleanup. Its inherited
    // unguessable label remains evidence of ownership even across setsid/exec.
    // This raw output is never logged, returned, or stored in the report.
    if (process.platform === "linux") {
      yield* Effect.forEach([...table.keys()], pid => fs.readFileString(`/proc/${pid}/environ`).pipe(
        Effect.catch(() => Effect.succeed("")), Effect.tap(environment => Effect.sync(() => {
          if (environment.split("\0").includes(`${tokenKey}=${token}`)) owned.add(pid);
        }))), { concurrency: 8, discard: true });
    } else {
      const labelled = yield* inspect(["axeww", "-o", "pid=,lstart=,command="]);
      const label = new RegExp("(?:^|\\s)" + tokenKey + "=" + token + "(?:\\s|$)");
      // Environments can contain newlines. Bulk rows nominate candidates only;
      // verify their individual environment, never a token in somebody's argv.
      const rows = [...labelled.stdout.matchAll(/^\s*(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s/gm)];
      for (const [index, row] of rows.entries()) {
        const pid = Number(row[1]);
        const record = labelled.stdout.slice(row.index, rows[index + 1]?.index);
        if (owned.has(pid) || table.get(pid)?.birth !== row[2]?.trim() || !label.test(record)) continue;
        const argv = yield* inspect(["ww", "-p", String(pid), "-o", "command="]).pipe(Effect.result);
        const environment = yield* inspect(["eww", "-p", String(pid), "-o", "command="]).pipe(Effect.result);
        const after = yield* inspect(["ww", "-p", String(pid), "-o", "command="]).pipe(Effect.result);
        if (Result.isFailure(argv) || Result.isFailure(environment) || Result.isFailure(after)) continue;
        const prefix = argv.success.stdout.trimEnd();
        if (prefix && prefix === after.success.stdout.trimEnd() && environment.success.stdout.startsWith(prefix + " ") &&
          label.test(environment.success.stdout.slice(prefix.length))) uncertain.add(pid);
      }
    }
    // Discover non-Node descendants too, without assuming they kept our env.
    let added: boolean;
    do {
      added = false;
      for (const item of table.values()) if (owned.has(item.ppid) && !owned.has(item.pid)) { owned.add(item.pid); added = true; }
    } while (added);
    // Darwin's ps output cannot distinguish a copied label inside an env value
    // from an actual key. A label alone must never authorize signalling another
    // session: require its birth ledger or current PPID chain, otherwise warn.
    const unverified = [...uncertain].filter(pid => !owned.has(pid));
    if (unverified.length && ![...owned].some(pid => !keep.has(pid))) return yield* new TestSpawnError({ command, message: `Cannot verify test process ownership for PIDs: ${unverified.join(", ")}; not signalled` });
    if (unverified.length) yield* Console.warn(`Warning: unverified process PIDs ${unverified.join(", ")}; not signalled. Cleaning verified descendants first.`);
    return [...owned].flatMap(pid => table.has(pid) && !keep.has(pid) ? [table.get(pid)!] : []);
  });
  const signal = (pending: ReadonlyArray<ProcessInfo>, value: "SIGSTOP" | "SIGKILL") => Effect.gen(function* () {
    const current = yield* snapshot;
    for (const item of pending) {
      if (current.get(item.pid)?.birth !== item.birth) continue; // PID was reused: it is no longer ours.
      yield* Effect.sync(() => {
        try {
          if (roots.has(item.pid) && current.get(item.pid)?.pgid === item.pid) process.kill(-item.pid, value);
        } catch { /* The group may already be gone. Still check the PID. */ }
        try { process.kill(item.pid, value); }
        catch { /* Verification below reports any survivor by PID. */ }
      });
    }
  });
  // A scratch-path match nominates a survivor for warning, never for killing.
  const warnUnowned = Effect.gen(function* () {
    if (!scratch) return;
    const table = yield* snapshot;
    const registered = yield* fs.readFileString(ledger);
    const known = new Set(registered.split("\n").flatMap(line => {
      const parsed = Schema.decodeOption(Schema.fromJsonString(Record))(line);
      return parsed._tag === "Some" && table.get(parsed.value.pid)?.birth === parsed.value.birth ? [parsed.value.pid] : [];
    }));
    const candidates = new Set<number>();
    const argv = yield* inspect(["-A", "-o", "pid=,args="]);
    for (const line of argv.stdout.split("\n")) {
      const row = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (row && row[2]!.includes(scratch)) candidates.add(Number(row[1]));
    }
    if (process.platform === "linux") yield* Effect.forEach([...table.keys()].filter(pid => !known.has(pid)), pid => fs.readLink(`/proc/${pid}/cwd`).pipe(
      Effect.catch(() => Effect.succeed("")), Effect.tap(cwd => Effect.sync(() => { if (cwd === scratch || cwd.startsWith(scratch + "/")) candidates.add(pid); }))), { concurrency: 8, discard: true });
    else if (process.platform === "darwin") {
      const cwd = yield* Effect.tryPromise({ try: () => execute("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, env: { PATH: process.env.PATH, LC_ALL: "C" } }), catch: () => new TestSpawnError({ command: ["lsof"], message: "Cannot inspect scratch working directories" }) }).pipe(Effect.catch(() => Console.warn("Warning: cannot inspect scratch working directories; argv backstop remains active").pipe(Effect.as({ stdout: "" }))));
      let pid = 0;
      for (const row of cwd.stdout.split("\n")) {
        if (row.startsWith("p")) pid = Number(row.slice(1));
        if (row.startsWith("n") && (row.slice(1) === scratch || row.slice(1).startsWith(scratch + "/"))) candidates.add(pid);
      }
    }
    const survivors = [...candidates].filter(pid => table.has(pid) && !known.has(pid));
    if (survivors.length) yield* Console.warn(`Warning: unowned scratch-related process PIDs ${survivors.join(", ")} survived; not signalled because ownership is unproven`);
  }).pipe(Effect.catch(() => Console.warn("Warning: cannot inspect unowned scratch-related survivors; no unverified PID was signalled")));
  const semaphore = yield* Semaphore.make(1);
  type Outcome = "clean" | "warning";
  let closed: Outcome | undefined;
  const sweep = (preserved: ReadonlyArray<number>, retained: ReadonlyArray<Record> = []) => Effect.scoped(Effect.gen(function* () {
  const keep = new Set(preserved);
  const discovering = createEffectLogic(() => discover(keep, retained).pipe(Effect.result));
  const stopping = createEffectLogic(({ input }: { input: ReadonlyArray<ProcessInfo> }) => signal(input, "SIGSTOP").pipe(Effect.result));
  const killing = createEffectLogic(({ input }: { input: ReadonlyArray<ProcessInfo> }) => signal(input, "SIGKILL").pipe(Effect.result));
  // tracking -> discovering -> stopping -> killing -> verifying -> closed.
  // A newly discovered descendant repeats stopping. Unverifiable ownership
  // warns rather than blocking the remaining mutation run.
  const machine = setupEffect({ schemas: { context: types<CleanupState>(), events: { CLOSE: Schema.Struct({}) } },
    actors: { discovering, stopping, killing } }).createMachine({
    context: { pending: [], round: 0, failure: undefined }, output: ({ context }) => context,
    initial: "tracking", states: {
      tracking: { on: { CLOSE: { target: "discovering" } } },
      discovering: { invoke: { src: "discovering", onDone: ({ context, event }) => Result.isFailure(event.output)
        ? { target: "failed", context: { ...context, failure: event.output.failure.message } }
        : { target: event.output.success.length ? "stopping" : "closed", context: { ...context, pending: event.output.success } } } },
      stopping: { invoke: { src: "stopping", input: ({ context }) => context.pending, onDone: ({ context, event }) => Result.isFailure(event.output)
        ? { target: "failed", context: { ...context, failure: event.output.failure.message } }
        : { target: "killing" } } },
      killing: { invoke: { src: "killing", input: ({ context }) => context.pending, onDone: ({ context, event }) => Result.isFailure(event.output)
        ? { target: "failed", context: { ...context, failure: event.output.failure.message } }
        : { target: "verifying" } } },
      verifying: { invoke: { src: "discovering", onDone: ({ context, event }) => {
        if (Result.isFailure(event.output)) return { target: "failed", context: { ...context, failure: event.output.failure.message } };
        const remaining = event.output.success;
        if (!remaining.length) return { target: "closed", context: { ...context, pending: [] } };
        return context.round < 3 ? { target: "stopping", context: { ...context, pending: remaining, round: context.round + 1 } }
          : { target: "failed", context: { ...context, pending: remaining, failure: `Cannot kill owned test PIDs: ${remaining.map(item => item.pid).join(", ")}` } };
      } } },
      closed: { type: "final" }, failed: { type: "final" }
    }
  });
  const actor = yield* createEffectActor(machine);
  yield* send(actor, { type: "CLOSE" });
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Inspection failures are machine outputs; join failures are unexpected actor defects.
  const result = yield* join(actor).pipe(Effect.orDie);
  yield* warnUnowned;
  if (result.failure) yield* Console.warn(`Warning: ${result.failure} (tracked PIDs ${(result.pending.length ? result.pending.map(item => item.pid) : [...roots]).join(", ")}); ownership ledger kept at ${ledger}; continuing without reusing the host`);
  return result.failure ? "warning" as const : "clean" as const;
  })).pipe(Effect.uninterruptible);
  const reap = (preserved: ReadonlyArray<number>, retained: ReadonlyArray<Record> = []) => semaphore.withPermit(Effect.suspend(() => closed === undefined ? sweep(preserved, retained) : Effect.succeed(closed)));
  const cleanup = semaphore.withPermit(Effect.gen(function* () {
    if (closed === undefined) closed = yield* sweep([]);
  }));
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* cleanup;
    if (closed === "clean") yield* fs.remove(directory, { recursive: true }).pipe(
      Effect.catch(error => Console.warn(`Warning: cannot remove process ledger directory: ${error.message}`)));
  }));
  const existing = process.env.NODE_OPTIONS ?? "";
  return {
    env: { ...process.env, MUTANT_CAFE_PROCESS_PHASE: undefined, [tokenKey]: token, [ledgerKey]: ledger, [preloadKey]: url, NODE_OPTIONS: `${existing} --import=${url}`.trim() },
    addRoot: (pid: number) => { roots.add(pid); }, cleanup, reap
  };
});
export type OwnedProcessTree = Effect.Success<ReturnType<typeof acquireProcessTree>>;
