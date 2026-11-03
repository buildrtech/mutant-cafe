// Executed in the target project's Node process, not in the CLI's dependency graph.
// API verified against Vitest 5.1.0. Unsupported API shapes use the cold adapter.
export interface ProbeOptions { readonly token: string; readonly setupFile: string }

export const reporterSource = (marker: string, probe?: ProbeOptions) => `
import { relative } from "node:path";
export default class {
  files = []; collected = false; failed = false; durations = {}; timeouts = {}; workers = 0; concurrency = 0; fileDurations = {}; firstTestStart = 0; verdict = null;
  constructor(token = ${JSON.stringify(probe?.token ?? null)}, setupFile = ${JSON.stringify(probe?.setupFile ?? null)}) { this.token = token; this.setupFile = setupFile; this.loaded = false; this.originals = []; }
  onInit(ctx) {
    if (!this.setupFile) return;
    for (const config of new Set(ctx.projects.map(project => project.config))) {
      this.originals.push([config, config.setupFiles]);
      config.setupFiles = [this.setupFile, ...config.setupFiles];
    }
  }
  restore() { for (const [config, setupFiles] of this.originals) config.setupFiles = setupFiles; this.originals = []; }
  onUserConsoleLog(log) {
    if (this.token && log.content.includes(this.token)) { this.loaded = true; process.send?.({ type: "probeLoaded" }); console.log(${JSON.stringify(marker + "probeLoaded")}); }
  }
  onTestRunStart(specifications) {
    this.probeSupported = specifications.every(spec => ["forks", "threads", "vmForks", "vmThreads"].includes(spec.pool) && spec.project.config.environment === "node");
    console.log(${JSON.stringify(marker + "probeSupported:")} + JSON.stringify(this.probeSupported));
    this.workers = Math.max(0, ...specifications.map(spec => spec.project.config.maxWorkers));
    console.log(${JSON.stringify(marker + "workers:")} + this.workers);
    this.files = specifications.map(spec => relative(process.cwd(), spec.moduleId));
    process.send?.({ type: "selected", files: this.files });
    console.log(${JSON.stringify(marker + "selected:")} + JSON.stringify(this.files));
  }
  onTestModuleCollected() {
    this.collected = true;
    process.send?.({ type: "collected" });
    console.log(${JSON.stringify(marker + "collected")});
  }
  onTestModuleEnd(module) {
    const file = relative(process.cwd(), module.moduleId);
    const timing = module.diagnostic();
    this.fileDurations[file] = timing.duration + timing.collectDuration + timing.prepareDuration + timing.setupDuration + timing.environmentSetupDuration;
    console.log(${JSON.stringify(marker + "fileDuration:")} + JSON.stringify({ file, duration: this.fileDurations[file] }));
    this.concurrency = Math.max(this.concurrency, timing.concurrencyId ?? 0);
    console.log(${JSON.stringify(marker + "concurrency:")} + this.concurrency);
  }
  onTestCaseResult(test) {
    const state = test.result().state;
    if (state === "failed") { this.failed = true; process.send?.({ type: "failed" }); console.log(${JSON.stringify(marker + "failed")}); }
    if (state === "passed") {
      const start = test.diagnostic()?.startTime ?? 0;
      if (start > 0) this.firstTestStart = this.firstTestStart ? Math.min(this.firstTestStart, start) : start;
      const file = relative(process.cwd(), test.module.moduleId);
      this.durations[file] = Math.max(this.durations[file] ?? 0, test.diagnostic()?.duration ?? 0);
      this.timeouts[file] = Math.max(this.timeouts[file] ?? 0, test.options.timeout ?? 0);
      console.log(${JSON.stringify(marker + "duration:")} + JSON.stringify({ file, duration: this.durations[file], timeout: this.timeouts[file], start: this.firstTestStart }));
    }
  }
  onTestRunEnd(modules, errors = [], state) {
    this.verdict = state ?? null;
    // Vitest's official run verdict also covers cancelled or pending modules.
    // Parallel bail can omit case-result hooks and module-end results.
    if ((state != null && state !== "passed") || errors.length) { this.failed = true; process.send?.({ type: "failed" }); console.log(${JSON.stringify(marker + "failed")}); }
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
let ctx;
let reporter;
try {
  const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
  if (typeof createVitest !== "function") throw new Error("createVitest is unavailable");
  ctx = await createVitest({ root: process.cwd(), run: true, watch: false, cache: false, fsModuleCache: false,
    bail: 1, passWithNoTests: true, reporters: ["default", new Reporter()] });
  if (typeof ctx.runTestSpecifications !== "function" || typeof ctx.invalidateFile !== "function"
    || typeof ctx.cancelCurrentRun !== "function" || typeof ctx.getRelevantTestSpecifications !== "function") {
    throw new Error("installed Vitest does not expose the supported warm API");
  }
  const isolated = config => config.isolate !== false &&
    !Object.values(config.poolOptions ?? {}).some(pool => pool?.isolate === false);
  const script = JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts?.test ?? "";
  if (/(?:^|\s)--no-isolate(?:\s|$)|--isolate(?:=|\s+)false/.test(script) || !isolated(ctx.config) || !isolated(ctx.vite.config.test ?? {}) ||
    ctx.projects.some(project => !isolated(project.config) || !isolated(project.vite.config.test ?? {}))) {
    throw new Error("isolate: false (including poolOptions or --no-isolate) cannot reset module state");
  }
  await ctx.standalone();
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
    if (request.testTimeout === undefined) delete ctx.configOverride.testTimeout;
    else ctx.configOverride.testTimeout = request.testTimeout;
    const specs = await ctx.getRelevantTestSpecifications();
    // The shared adapter handles the full-suite fallback and remaining budget.
    const empty = specs.length === 0;
    const result = await ctx.runTestSpecifications(specs, !request.file);
    if (!["passed", "failed", "interrupted"].includes(reporter.verdict)) throw new Error("installed Vitest does not expose the supported current-run verdict");
    // Use the official current-run verdict, not retained module state. In a
    // parallel bail, child failures can exist while the module stays pending.
    const failed = reporter.failed || result.unhandledErrors.length > 0;
    process.send({ type: "result", status: failed ? "failed" : empty ? "untested" : "passed",
      testFiles: reporter.files, testsCollected: reporter.collected, testDurations: reporter.durations, testTimeouts: reporter.timeouts, testWorkers: reporter.workers, testConcurrency: reporter.concurrency, testFileDurations: reporter.fileDurations, firstTestStart: reporter.firstTestStart, probeSupported: reporter.probeSupported, probeLoaded: reporter.loaded,
      crashed: result.unhandledErrors.length > 0 });
    process.exitCode = 0;
  } catch (error) { reporter?.restore(); process.send({ type: "crash", message: String(error) }); }
});
`;
