// Executed in the target project's Node process, not in the CLI's dependency graph.
// API verified against Vitest 5.1.0. Unsupported API shapes use the cold adapter.
import { warmPolicySource, workerDeathSource } from "./WarmPolicy.ts";

export interface ProbeOptions { readonly token: string; readonly setupFile: string }

export const reporterSource = (marker: string, probe?: ProbeOptions) => `
import { relative, dirname } from "node:path";
${workerDeathSource}
export default class {
  files = []; collected = false; failed = false; durations = {}; timeouts = {}; workers = 0; concurrency = 0; fileDurations = {}; firstTestStart = 0; verdict = null; crashed = false;
  constructor(token = ${JSON.stringify(probe?.token ?? null)}, setupFile = ${JSON.stringify(probe?.setupFile ?? null)}) { this.token = token; this.setupFile = setupFile; this.loaded = false; this.originals = []; this.timeoutDetails = {}; this.activeModules = new Set(); this.hooks = new Map(); this.allowances = []; this.telemetryWarnings = []; }
  onInit(ctx) {
    this.ctx = ctx;
    if (!this.setupFile) return;
    for (const vite of new Set(ctx.projects.map(project => project.vite.config))) {
      const fs = vite.server?.fs;
      if (fs) { this.allowances.push([fs, fs.allow]); fs.allow = [...fs.allow, dirname(this.setupFile)]; }
    }
    for (const config of new Set(ctx.projects.map(project => project.config))) {
      this.originals.push([config, config.setupFiles]);
      config.setupFiles = [this.setupFile, ...config.setupFiles];
    }
  }
  restore() {
    for (const [config, setupFiles] of this.originals) config.setupFiles = setupFiles;
    for (const [fs, allow] of this.allowances) fs.allow = allow;
    this.originals = []; this.allowances = [];
  }
  onHookStart(hook) { this.hooks.set(hook.entity.id + hook.name, performance.now()); }
  onHookEnd(hook) {
    const module = hook.entity.module ?? hook.entity;
    const started = this.hooks.get(hook.entity.id + hook.name);
    if (module.moduleId && started !== undefined) {
      const file = relative(process.cwd(), module.moduleId);
      this.durations[file] = Math.max(this.durations[file] ?? 0, performance.now() - started);
      console.log(${JSON.stringify(marker + "duration:")} + JSON.stringify({ file, duration: this.durations[file], timeout: 0, key: file + "::hook::" + hook.entity.id + hook.name, start: this.firstTestStart }));
    }
  }
  onUserConsoleLog(log) {
    if (this.token && log.content.includes(this.token)) { this.loaded = true; process.send?.({ type: "probeLoaded" }); console.log(${JSON.stringify(marker + "probeLoaded")}); }
  }
  onTestRunStart(specifications) {
    this.probeSupported = specifications.every(spec => ["forks", "threads", "vmForks", "vmThreads"].includes(spec.pool) && spec.project.config.environment === "node");
    console.log(${JSON.stringify(marker + "probeSupported:")} + JSON.stringify(this.probeSupported));
    const workers = this.ctx.config.maxWorkers;
    this.workers = Number.isSafeInteger(workers) && workers > 0 ? workers : undefined;
    if (this.workers !== undefined) console.log(${JSON.stringify(marker + "workers:")} + this.workers);
    else {
      const warning = "Internal reporter telemetry error: testWorkers=" + String(workers) + "; resolved worker budget unavailable, omitted";
      this.telemetryWarnings.push(warning);
      console.log(${JSON.stringify(marker + "telemetryWarning:")} + JSON.stringify(warning));
    }
    this.files = specifications.map(spec => relative(process.cwd(), spec.moduleId));
    process.send?.({ type: "selected", files: this.files });
    console.log(${JSON.stringify(marker + "selected:")} + JSON.stringify(this.files));
  }
  onTestModuleStart(module) {
    this.activeModules.add(module.moduleId);
    this.concurrency = Math.max(this.concurrency, this.activeModules.size);
    console.log(${JSON.stringify(marker + "concurrency:")} + this.concurrency);
  }
  onTestModuleCollected() {
    this.collected = true;
    process.send?.({ type: "collected" });
    console.log(${JSON.stringify(marker + "collected")});
  }
  onTestModuleEnd(module) {
    const file = relative(process.cwd(), module.moduleId);
    this.crashed ||= (module.errors?.() ?? []).some(error => workerDied(error));
    const timing = module.diagnostic();
    this.fileDurations[file] = timing.duration + timing.collectDuration + timing.prepareDuration + timing.setupDuration + timing.environmentSetupDuration;
    console.log(${JSON.stringify(marker + "fileDuration:")} + JSON.stringify({ file, duration: this.fileDurations[file] }));
    this.activeModules.delete(module.moduleId);
  }
  onTestCaseResult(test) {
    const result = test.result();
    this.crashed ||= (result.errors ?? []).some(error => workerDied(error));
    const state = result.state;
    if (state === "failed") { this.failed = true; process.send?.({ type: "failed" }); console.log(${JSON.stringify(marker + "failed")}); }
    if (state === "passed") {
      const start = test.diagnostic()?.startTime ?? 0;
      if (start > 0) this.firstTestStart = this.firstTestStart ? Math.min(this.firstTestStart, start) : start;
      const file = relative(process.cwd(), test.module.moduleId);
      this.durations[file] = Math.max(this.durations[file] ?? 0, test.diagnostic()?.duration ?? 0);
      this.timeouts[file] = Math.max(this.timeouts[file] ?? 0, test.options.timeout ?? 0);
      this.timeoutDetails[file + "::" + test.id] = test.options.timeout ?? 0;
      console.log(${JSON.stringify(marker + "duration:")} + JSON.stringify({ file, duration: this.durations[file], timeout: this.timeouts[file], key: file + "::" + test.id, start: this.firstTestStart }));
    }
  }
  onTestRunEnd(modules, errors = [], state) {
    this.verdict = state ?? null;
    this.crashed ||= errors.some(error => workerDied(error)) || modules.some(module => workerDied(module.task) || (module.errors?.() ?? []).some(error => workerDied(error)));
    // Vitest's official run verdict also covers cancelled or pending modules.
    // Parallel bail can omit case-result hooks and module-end results.
    if ((state != null && state !== "passed") || (!this.ctx?.config.dangerouslyIgnoreUnhandledErrors && errors.length)) { this.failed = true; process.send?.({ type: "failed" }); console.log(${JSON.stringify(marker + "failed")}); }
    if (!this.files.length) console.log(${JSON.stringify(marker + "empty")});
    this.restore();
  }
}`;

export const vitestHostSource = String.raw`
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
const require = createRequire(resolve("package.json"));
const { default: Reporter } = await import(pathToFileURL(process.argv[2]).href);
${warmPolicySource}
${workerDeathSource}
let ctx;
let reporter;
const retained = () => {
  try { return readFileSync(process.env.MUTANT_CAFE_PROCESS_LEDGER, "utf8").split("\n").filter(Boolean).flatMap(line => { try { const item = JSON.parse(line); return item.phase === "setup" ? [{ pid: item.pid, birth: item.birth }] : []; } catch { return []; } }); }
  catch { return []; }
};
const setup = async fn => {
  const previous = process.env.MUTANT_CAFE_PROCESS_PHASE;
  process.env.MUTANT_CAFE_PROCESS_PHASE = "setup";
  try { return await fn(); } finally { if (previous === undefined) delete process.env.MUTANT_CAFE_PROCESS_PHASE; else process.env.MUTANT_CAFE_PROCESS_PHASE = previous; }
};
try {
  const version = JSON.parse(readFileSync(require.resolve("vitest/package.json"), "utf8")).version;
  const versionRefusal = warmRefusal(version, null);
  if (versionRefusal) throw new Error(versionRefusal);
  const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
  if (typeof createVitest !== "function") throw new Error("createVitest is unavailable");
  ctx = await setup(() => createVitest({ root: process.cwd(), run: true, watch: false, cache: false, fsModuleCache: false,
    bail: 1, passWithNoTests: true, reporters: ["default", new Reporter()] }, { plugins: [{ name: "mutant-cafe-health", resolveId(id) { if (id === "virtual:mutant-cafe-health") return "\0mutant-cafe-health"; }, load(id) { if (id === "\0mutant-cafe-health") return "export default 1"; } }] }));
  if (typeof ctx.runTestSpecifications !== "function" || typeof ctx.invalidateFile !== "function"
    || typeof ctx.cancelCurrentRun !== "function" || typeof ctx.getRelevantTestSpecifications !== "function" || typeof ctx.initializeGlobalSetup !== "function") {
    throw new Error("installed Vitest does not expose the supported warm API");
  }
  const refusal = warmRefusal(version, ctx, process.argv[3] === "select");
  if (refusal) throw new Error(refusal);
  const isolated = config => config.isolate !== false &&
    !Object.values(config.poolOptions ?? {}).some(pool => pool?.isolate === false);
  const script = JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts?.test ?? "";
  if (process.argv[3] !== "select" && (/(?:^|\s)--no-isolate(?:\s|$)|--isolate(?:=|\s+)false/.test(script) || !isolated(ctx.config) || !isolated(ctx.vite.config.test ?? {}) ||
    ctx.projects.some(project => !isolated(project.config) || !isolated(project.vite.config.test ?? {})))) {
    throw new Error("isolate: false (including poolOptions or --no-isolate) cannot reset module state");
  }
  const initialize = ctx.initializeGlobalSetup.bind(ctx);
  ctx.initializeGlobalSetup = (...args) => setup(async () => {
    const result = await initialize(...args);
    process.send({ type: "retained", pids: retained() });
    return result;
  });
  await setup(() => ctx.standalone());
  process.send({ type: "retained", pids: retained() });
  process.send({ type: "ready" });
} catch (error) {
  process.send({ type: "fallback", message: String(error) });
  await ctx?.close();
  process.exit(0);
}
// invalidateFile clears Vitest's transform cache. Walk importers explicitly as
// well, and queue every path for the pool's module runner invalidation boundary.
function invalidate(file) {
  const paths = new Set([resolve(file)]);
  for (const project of ctx.projects) {
    for (const environment of Object.values(project.vite.environments)) {
      const seen = new Set();
      const visit = module => {
        if (seen.has(module)) return;
        seen.add(module);
        if (module.file) paths.add(module.file);
        for (const importer of module.importers) visit(importer);
      };
      for (const module of environment.moduleGraph.getModulesByFile(resolve(file)) ?? []) visit(module);
    }
  }
  for (const path of paths) { ctx.invalidateFile(path); ctx.watcher.invalidates.add(path); }
}
const defaultReporters = ctx.reporters.filter(reporter => !(reporter instanceof Reporter));
process.on("message", async request => {
  try {
    if (request.type === "close") { await ctx.close(); process.exit(0); }
    if (request.type === "cancel") { await ctx.cancelCurrentRun("keyboard-input"); return; }
    if (request.type === "invalidate") { invalidate(request.file); process.send({ type: "invalidated" }); return; }
    if (request.type === "ping") {
      if (!ctx.runningPromise) ctx.cancelPromise = undefined;
      const module = ctx.vite.moduleGraph?.getModuleById("\0mutant-cafe-health");
      if (module) ctx.vite.moduleGraph.invalidateModule(module);
      const transformed = await ctx.vite.transformRequest("virtual:mutant-cafe-health");
      if (!transformed?.code) throw new Error("health transform failed");
      process.send({ type: "healthy" });
      return;
    }
    if (request.type === "quiesce") {
      const pool = ctx.pool;
      ctx.pool = undefined;
      let closing;
      try { closing = pool?.close?.(); } catch { /* Disposable pool is already dead. */ }
      process.send({ type: "quiescing" });
      try { await closing; } catch { /* Parent verifies and reaps its children. */ }
      process.send({ type: "quiesced" });
      return;
    }
    if (request.type === "select") {
      ctx.config.related = [resolve(request.file)];
      const specs = await ctx.getRelevantTestSpecifications();
      process.send({ type: "selection", files: specs.map(spec => spec.moduleId) });
      return;
    }
    if (request.type !== "run") return;
    reporter = new Reporter(request.probe?.token ?? null, request.probe?.setupFile ?? null);
    reporter.onInit(ctx);
    ctx.reporters = [...defaultReporters, reporter];
    ctx.config.related = request.file ? [resolve(request.file)] : undefined;
    if (request.testTimeout === undefined) { delete ctx.configOverride.testTimeout; delete ctx.configOverride.hookTimeout; }
    else { ctx.configOverride.testTimeout = request.testTimeout; ctx.configOverride.hookTimeout = request.testTimeout; }
    const specs = await ctx.getRelevantTestSpecifications();
    // The shared adapter handles the full-suite fallback and remaining budget.
    const empty = specs.length === 0;
    let result;
    try { result = await ctx.runTestSpecifications(specs, !request.file); }
    catch (error) {
      // A thrown run error (for example a mutant breaking global setup) is a
      // failure, not evidence that the host or a worker died.
      console.error(error?.stack ?? String(error));
      reporter.failed = true;
      reporter.verdict = "failed";
      result = { unhandledErrors: [error] };
    }
    if (!["passed", "failed", "interrupted"].includes(reporter.verdict)) throw new Error("installed Vitest does not expose the supported current-run verdict");
    // Use the official current-run verdict, not retained module state. In a
    // parallel bail, child failures can exist while the module stays pending.
    process.send({ type: "retained", pids: retained() });
    const failed = reporter.failed || (!ctx.config.dangerouslyIgnoreUnhandledErrors && result.unhandledErrors.length > 0);
    process.send({ type: "result", status: failed ? "failed" : empty ? "untested" : "passed",
      testFiles: reporter.files, testsCollected: reporter.collected, testDurations: reporter.durations, testTimeouts: reporter.timeouts, testWorkers: reporter.workers, testConcurrency: reporter.concurrency, testFileDurations: reporter.fileDurations, firstTestStart: reporter.firstTestStart, probeSupported: reporter.probeSupported, probeLoaded: reporter.loaded, testTimeoutDetails: reporter.timeoutDetails,
      telemetryWarnings: reporter.telemetryWarnings, crashed: reporter.crashed || result.unhandledErrors.some(error => workerDied(error)) });
    process.exitCode = 0;
  } catch (error) { reporter?.restore(); process.send({ type: "crash", message: String(error) }); }
});
`;
