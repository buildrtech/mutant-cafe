import { describe, expect, it } from "@effect/vitest";
import { MutantSource, Reporter, Scratch, TestRunner, type Mutant, type RunConfig, type RunReport } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { preflight } from "../src/Preflight.ts";
import { runMutants, ScratchLive, TestRunnerLive } from "../src/index.ts";

const root = decodeURIComponent(new URL("../../../fixtures/tagged-errors/", import.meta.url).pathname).replace(/\/$/, "");
const file = "src/account.ts";
const live = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(Layer.provideMerge(NodeServices.layer));
const config = (location = root): RunConfig => ({
  root: location, tsconfig: "tsconfig.json", include: ["src/**/*.ts"], exclude: [], functionFilter: [],
  jobs: 1, timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 900, outDir: "mutants.out"
});
const mutation = (original: string, id: string, text: string, genre: Mutant["genre"] = "EffectSucceed"): Mutant => {
  const startOffset = original.indexOf("  if (account.frozen)");
  const endOffset = original.indexOf("\n};", startOffset);
  return {
    id, file, functionName: "withdraw", returnType: "Effect<Account, Overdrawn | Frozen>", genre,
    description: id, span: { start: { line: 20, column: 1 }, end: { line: 28, column: 1 } },
    replacement: { startOffset, endOffset, text }, synthetic: false
  };
};
const source = MutantSource.of({ notMutated: () => Effect.succeed([]), generate: () => Stream.empty, checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) });
const withPorts = <A, E, R>(effect: Effect.Effect<A, E, R>, reports: Array<RunReport>, mutantSource = source) => effect.pipe(
  Effect.provideService(MutantSource, mutantSource),
  Effect.provideService(Reporter, { progress: () => Effect.void, write: (report) => Effect.sync(() => { reports.push(report); }) })
);

const selectionFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "selection-" });
  yield* fs.symlink(`${root}/node_modules`, `${dir}/node_modules`);
  yield* fs.makeDirectory(`${dir}/src`);
  yield* fs.makeDirectory(`${dir}/test`);
  yield* fs.writeFileString(`${dir}/package.json`, '{"type":"module"}');
  yield* fs.writeFileString(`${dir}/vitest.config.ts`, 'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 0 } };');
  return { path: dir, apply: () => Effect.void, revert: () => Effect.void };
});

describe("real vitest mutation runs", () => {
  for (const script of ["pnpm exec vitest", "npx vitest", "cross-env MODE=test vitest run", "vitest run && tsc --noEmit", "vitest --project unit"]) {
    it.live(`recognizes the Vitest wrapper ${script}`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* selectionFixture;
      yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ type: "module", scripts: { test: script } }));
      yield* fs.writeFileString(`${dir.path}/src/value.ts`, "export const value = true;");
      yield* fs.writeFileString(`${dir.path}/test/value.test.ts`, 'import { it, expect } from "vitest"; import { value } from "../src/value.ts"; it("value", () => expect(value).toBe(true));');
      expect(yield* preflight(dir.path)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(live)), 20_000);
  }
  for (const script of ["turbo run test", "pnpm -r test", "custom-test-wrapper"]) {
    it.live(`reports delegated selection as unverified for ${script}`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* selectionFixture;
      yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ type: "module", scripts: { test: script } }));
      const issues = yield* preflight(dir.path);
      expect(issues[0]?.kind).toBe("warning");
      expect(issues[0]?.reason).toContain(script === "custom-test-wrapper" ? "unknown test wrapper" : "delegated test runner");
      expect(issues[0]?.reason).toContain("unverified");
      expect(issues[0]?.reason).not.toContain("only runs Vitest");
      yield* fs.writeFileString(`${dir.path}/test/visible.test.ts`, 'import { it, expect } from "vitest"; it("baseline executes", () => expect(1).toBe(1));');
      const tests = yield* TestRunner;
      const baseline = yield* tests.baseline(dir);
      expect(baseline.durationMs).toBeGreaterThan(0);
      expect(baseline.testCommand).toContain("--reporter=default");
    }).pipe(Effect.scoped, Effect.provide(live)), 20_000);
  }
  for (const name of ["unit.spec.ts", "__tests__/unit.ts", "unit.test.mts"]) {
    it.live(`respects Vitest resolved inclusion for ${name}`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* selectionFixture;
      yield* fs.makeDirectory(`${dir.path}/__tests__`);
      yield* fs.writeFileString(`${dir.path}/vitest.config.ts`, JSON.stringify({ test: { include: [name] } }).replace(/^/, "export default "));
      yield* fs.writeFileString(`${dir.path}/src/value.ts`, "export const value = true;");
      yield* fs.writeFileString(`${dir.path}/${name}`, `import { it, expect } from "vitest"; import { value } from "${name.includes("/") ? "../" : "./"}src/value.ts"; it("value", () => expect(value).toBe(true));`);
      expect(yield* preflight(dir.path)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(live)), 20_000);
  }
  for (const output of ["dist", "compiled"]) {
    it.live(`marks package self-imports of ${output} output unreliable`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* selectionFixture;
      yield* fs.makeDirectory(`${dir.path}/${output}`);
      yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ name: "self-built-fixture", type: "module", exports: { ".": { import: `./${output}/index.js` } }, scripts: { test: "vitest run" } }));
      const original = "export const value = () => true;";
      yield* fs.writeFileString(`${dir.path}/src/value.ts`, original);
      yield* fs.writeFileString(`${dir.path}/${output}/index.js`, original);
      yield* fs.writeFileString(`${dir.path}/test/value.test.ts`, 'import { it, expect } from "vitest"; import { value } from "self-built-fixture"; it("checks the build", () => expect(value()).toBe(true));');
      const startOffset = original.indexOf("true");
      const item = { ...mutation(original, "built-self", ""), file: "src/value.ts", replacement: { startOffset, endOffset: startOffset + 4, text: "false" } };
      const report = yield* withPorts(runMutants(config(dir.path), Stream.make(item)), []);
      expect(report.results[0]?.outcome).toBe("unreliable");
      expect(report.baseline.durationMs).toBeGreaterThan(0);
      expect(report.results[0]?.diagnostics.join("\n")).toContain(`${output}/index.js`);
      expect(report.results[0]?.diagnostics.join("\n")).toContain("built output");
      expect(yield* fs.readFileString(`${dir.path}/src/value.ts`)).toBe(original);
    }).pipe(Effect.scoped, Effect.provide(live)), 20_000);
  }

  for (const mapping of ["types", "tsconfig", "unmapped"]) {
    it.live(`scopes a built subpath by source closure and actual selected tests (${mapping})`, () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* selectionFixture;
      yield* fs.makeDirectory(`${dir.path}/dist`);
      yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ name: "built-subpath-fixture", type: "module", exports: { "./sub": { types: mapping === "types" ? "./src/sub.ts" : "./dist/sub.d.ts", import: "./dist/sub.js" } }, scripts: { test: "vitest run" } }));
      if (mapping === "tsconfig") {
        yield* fs.makeDirectory(`${dir.path}/config`);
        yield* fs.writeFileString(`${dir.path}/config/base.json`, '{ // build mapping\n "note": "// preserve quoted text", "compilerOptions": { "rootDir": "../unused", "outDir": "../dist", }, }');
        yield* fs.writeFileString(`${dir.path}/build.json`, '{ "extends": ["./config/base.json"], "compilerOptions": { "rootDir": "src" }, "include": ["src"] }');
      }
      const sub = 'import { ready } from "./dependency.ts"; export const sub = () => ready();';
      const dependency = 'export const ready = () => true;';
      const other = 'export const other = (n: number): number => n + 1;';
      yield* fs.writeFileString(`${dir.path}/src/sub.ts`, sub);
      yield* fs.writeFileString(`${dir.path}/src/dependency.ts`, dependency);
      yield* fs.writeFileString(`${dir.path}/src/other.ts`, other);
      yield* fs.writeFileString(`${dir.path}/src/orphan.ts`, dependency);
      yield* fs.writeFileString(`${dir.path}/dist/sub.js`, 'export const sub = () => true;');
      yield* fs.writeFileString(`${dir.path}/test/built.test.ts`, 'import { it, expect } from "vitest"; import { sub } from "built-subpath-fixture/sub"; it("built subpath", () => expect(sub()).toBe(true));');
      const directTest = 'import { it, expect } from "vitest"; import { other } from "../src/other.ts"; it("source", () => expect(other(1)).toBe(2));';
      yield* fs.writeFileString(`${dir.path}/test/source.test.ts`, directTest);
      const item = (file: string, original: string, expression: string, text: string, id: string): Mutant => ({ ...mutation(original, id, ""), file, replacement: { startOffset: original.indexOf(expression), endOffset: original.indexOf(expression) + expression.length, text } });
      const subMutant = item("src/sub.ts", sub, "ready()", "false", "sub");
      const depMutant = item("src/dependency.ts", dependency, "true", "false", "dependency");
      const runConfig = { ...config(dir.path), tsconfig: mapping === "tsconfig" ? `${dir.path}/build.json` : "tsconfig.json" };
      const first = yield* withPorts(runMutants(runConfig, Stream.fromIterable([subMutant, depMutant,
        item("src/other.ts", other, "n + 1", "0", "caught"), item("src/other.ts", other, "n + 1", "2", "missed"), item("src/orphan.ts", dependency, "true", "false", "orphan") ])), []);
      expect(first.baseline.durationMs).toBeGreaterThan(0);
      expect(first.baseline.testCommand).toContain("--reporter=default");
      expect(first.results.map(result => result.outcome)).toEqual(["unreliable", "unreliable", "caught", "missed", mapping === "unmapped" ? "unreliable" : "untested"]);
      const issue = first.baseline.unreliable?.find(issue => issue.kind === "built");
      expect(issue?.kind).toBe("built");
      if (issue?.kind === "built") {
        expect(issue.testFiles).toEqual(["test/built.test.ts"]);
        expect(issue.files).toEqual(mapping === "unmapped" ? undefined : ["src/sub.ts", "src/dependency.ts"]);
      }
      // Both tests remain selected by Vitest globally. Related selection now
      // reaches source directly, excludes the dist test, and must catch normally.
      yield* fs.writeFileString(`${dir.path}/test/source.test.ts`, directTest + '\nimport { sub } from "../src/sub.ts"; it("direct sub", () => expect(sub()).toBe(true));');
      const second = yield* withPorts(runMutants(runConfig, Stream.fromIterable([subMutant, depMutant])), []);
      expect(second.results.map(result => result.outcome)).toEqual(["caught", "caught"]);
      expect(yield* fs.readFileString(`${dir.path}/src/sub.ts`)).toBe(sub);
      expect(yield* fs.readFileString(`${dir.path}/src/dependency.ts`)).toBe(dependency);
    }).pipe(Effect.scoped, Effect.provide(live)), 40_000);
  }

  it.live("does not turn a selection probe failure into an unverified runner", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    yield* fs.writeFileString(`${dir.path}/vitest.config.ts`, 'throw new Error("broken fixture config"); export default {};');
    const issues = yield* preflight(dir.path);
    expect(issues.some(issue => issue.kind === "warning")).toBe(true);
    expect(issues.some(issue => issue.kind === "runner")).toBe(false);
    const tests = yield* TestRunner;
    const baseline = yield* tests.baseline(dir).pipe(Effect.result);
    expect(baseline._tag).toBe("Failure");
    if (baseline._tag === "Failure") {
      expect(baseline.failure._tag).toBe("BaselineFailed");
      if (baseline.failure._tag === "BaselineFailed") {
        expect(baseline.failure.command).toContain("--reporter=default");
        expect(baseline.failure.output).toContain("broken fixture config");
      }
    }
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("marks non-Vitest scripts and excluded importing tests unreliable before baseline", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    const original = "export const value = () => true;";
    yield* fs.writeFileString(`${dir.path}/src/target.ts`, original);
    const startOffset = original.indexOf("true");
    const item = { ...mutation(original, "hidden", ""), file: "src/target.ts", replacement: { startOffset, endOffset: startOffset + 4, text: "false" } };
    yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.ts" } }));
    let report = yield* withPorts(runMutants(config(dir.path), Stream.make(item)), []);
    expect(report.results[0]?.outcome).toBe("unreliable");
    expect(report.results[0]?.diagnostics.join("\n")).toContain("node --test");
    yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
    yield* fs.makeDirectory(`${dir.path}/ignored`);
    yield* fs.writeFileString(`${dir.path}/ignored/hidden.test.ts`, 'import { it, expect } from "vitest"; import { value } from "../src/target.ts"; it("checks target", () => expect(value()).toBe(true));');
    yield* fs.writeFileString(`${dir.path}/test/visible.test.ts`, 'import { it, expect } from "vitest"; it("unrelated", () => expect(1).toBe(1));');
    report = yield* withPorts(runMutants(config(dir.path), Stream.make(item)), []);
    expect(report.results[0]?.outcome).toBe("unreliable");
    expect(report.results[0]?.diagnostics.join("\n")).toContain("ignored/hidden.test.ts");
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("does not call three unreachable double mutants missed when the fallback suite passes", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    const original = "export const double = (n: number): number => n * 2;";
    yield* fs.writeFileString(`${dir.path}/src/double.ts`, original);
    yield* fs.writeFileString(`${dir.path}/test/unrelated.test.ts`, 'import { it, expect } from "vitest"; it("unrelated", () => expect(1).toBe(1));');
    const startOffset = original.indexOf("n * 2");
    const items = ["0", "1", "-1"].map(text => ({ ...mutation(original, `double-${text}`, ""), file: "src/double.ts", replacement: { startOffset, endOffset: startOffset + 5, text } }));
    const report = yield* withPorts(runMutants(config(dir.path), Stream.fromIterable(items)), []);
    expect(report.results.map(r => r.outcome)).toEqual(["untested", "untested", "untested"]);
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("repoints a workspace self-link so package-name imports catch the scratch mutation", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    yield* fs.remove(`${dir.path}/node_modules`);
    yield* fs.makeDirectory(`${dir.path}/node_modules`);
    for (const name of ["vitest", "effect"]) yield* fs.symlink(yield* fs.realPath(`${root}/node_modules/${name}`), `${dir.path}/node_modules/${name}`);
    yield* fs.symlink(dir.path, `${dir.path}/node_modules/self-fixture`);
    yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({ name: "self-fixture", type: "module", main: "./src/self.ts", scripts: { test: "vitest run" } }));
    const original = "export const value = () => true;";
    yield* fs.writeFileString(`${dir.path}/src/self.ts`, original);
    yield* fs.writeFileString(`${dir.path}/test/self.test.ts`, 'import { it, expect } from "vitest"; import { value } from "self-fixture"; it("reads its own package", () => expect(value()).toBe(true));');
    const startOffset = original.indexOf("true");
    const item = { ...mutation(original, "self", ""), file: "src/self.ts", replacement: { startOffset, endOffset: startOffset + 4, text: "false" } };
    const scratch = yield* Scratch;
    const oldCopy = yield* scratch.acquire(dir.path);
    yield* oldCopy.apply(item);
    // Recreate the old linked-node_modules behavior only in this disposable copy.
    yield* fs.remove(`${oldCopy.path}/node_modules/self-fixture`);
    yield* fs.symlink(dir.path, `${oldCopy.path}/node_modules/self-fixture`);
    const tests = yield* TestRunner;
    const escaped = yield* tests.runRelated(oldCopy, item.file, 5000);
    expect(escaped.status, escaped.output).toBe("untested");
    expect(escaped.output).toContain("1 passed");
    const report = yield* withPorts(runMutants(config(dir.path), Stream.make(item)), []);
    expect(report.results[0]?.outcome, report.results[0]?.output).toBe("caught");
    expect(yield* fs.readFileString(`${dir.path}/src/self.ts`)).toBe(original);
    expect(yield* fs.realPath(`${dir.path}/node_modules/self-fixture`)).toBe(dir.path);
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("falls back from no related files to the full suite, and distinguishes zero tests (B5)", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    yield* fs.writeFileString(`${dir.path}/src/orphan.ts`, 'export const value = () => 2;');
    yield* fs.writeFileString(`${dir.path}/test/indirect.test.ts`, 'import { it, expect } from "vitest"; const file = "../src/orphan.ts"; it("dynamic consumer", async () => { const m = await import(file); expect(m.value()).toBe(1); });');
    const tests = yield* TestRunner;
    expect((yield* tests.runRelated(dir, "src/orphan.ts", 5000)).status).toBe("failed");
    yield* fs.remove(`${dir.path}/test/indirect.test.ts`);
    expect((yield* tests.runRelated(dir, "src/orphan.ts", 5000)).status).toBe("untested");
  }).pipe(Effect.scoped, Effect.provide(live)), 20_000);

  it.live("does not credit slow tests that never call the Effect.never mutant (B9)", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    const original = 'import { Effect } from "effect"; export const untested = (): Effect.Effect<number> => Effect.succeed(1); export const answer = 42;';
    yield* fs.writeFileString(`${dir.path}/src/slow.ts`, original);
    yield* fs.writeFileString(`${dir.path}/test/slow.test.ts`, 'import { it, expect } from "vitest"; import { answer } from "../src/slow.ts"; it("slow unrelated consumer", async () => { await new Promise(r => setTimeout(r, 1500)); expect(answer).toBe(42); });');
    const startOffset = original.indexOf("Effect.succeed(1)");
    const item: Mutant = { ...mutation(original, "unused-never", "", "EffectNever"), file: "src/slow.ts", replacement: { startOffset, endOffset: startOffset + "Effect.succeed(1)".length, text: "Effect.never" } };
    const report = yield* withPorts(runMutants(config(dir.path), Stream.make(item)), []);
    expect(report.results.map((r) => r.outcome)).toEqual(["missed"]);
  }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("reports an empty package as untested rather than missed (B5)", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    const original = "export const value = () => true;";
    yield* fs.writeFileString(`${dir.path}/src/empty.ts`, original);
    const startOffset = original.indexOf("true");
    const item = { ...mutation(original, "empty", ""), file: "src/empty.ts", replacement: { startOffset, endOffset: startOffset + 4, text: "false" } };
    const report = yield* withPorts(runMutants(config(dir.path), Stream.make(item)), []);
    expect(report.results.map(r => r.outcome)).toEqual(["untested"]);
  }).pipe(Effect.scoped, Effect.provide(live)), 15_000);

  it.live("overrides disabled per-test timeouts inside the outer budget (B8)", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    yield* fs.writeFileString(`${dir.path}/src/hang.ts`, "export const value = 1;");
    yield* fs.writeFileString(`${dir.path}/test/hang.test.ts`, 'import { it } from "vitest"; import { value } from "../src/hang.ts"; it("waits forever", async () => { void value; await new Promise(() => {}); });');
    const tests = yield* TestRunner;
    const run = yield* tests.runRelated(dir, "src/hang.ts", 4000);
    expect(run.status, run.output).toBe("failed");
    expect(run.output).toContain("Test timed out");
    expect(run.durationMs).toBeLessThan(4000);
  }).pipe(Effect.scoped, Effect.provide(live)), 10_000);

  it.live("retains a fast test failure when another related file hangs (B16)", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    yield* fs.writeFileString(`${dir.path}/src/pick.ts`, 'import { Option } from "effect"; export const pick = (n: number) => Option.none<number>();');
    yield* fs.writeFileString(`${dir.path}/test/fast.test.ts`, 'import { it, expect } from "vitest"; import { Option } from "effect"; import { pick } from "../src/pick.ts"; it("keeps positives", () => expect(Option.isSome(pick(2))).toBe(true));');
    yield* fs.writeFileString(`${dir.path}/test/poll.test.ts`, 'import { it } from "vitest"; import { Option } from "effect"; import { pick } from "../src/pick.ts"; it("polls", async () => { while (Option.isNone(pick(1))) await new Promise(r => setTimeout(r, 10)); });');
    const tests = yield* TestRunner;
    const run = yield* tests.runRelated(dir, "src/pick.ts", 2500);
    expect(run.status, run.output).toBe("failed");
    expect(run.output).toContain("keeps positives");
  }).pipe(Effect.scoped, Effect.provide(live)), 10_000);

  it.live("does not credit a kill before test collection (B9)", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* selectionFixture;
    const original = 'import { Effect } from "effect"; export const value = () => Effect.succeed(1); export const ready = Effect.runSync(value());';
    yield* fs.writeFileString(`${dir.path}/src/loading.ts`, original);
    yield* fs.writeFileString(`${dir.path}/test/loading.test.ts`, 'import { it, expect } from "vitest"; import { ready } from "../src/loading.ts"; it("loads", () => expect(ready).toBe(1));');
    const startOffset = original.indexOf("Effect.succeed(1)");
    // Block module evaluation before Vitest has collected a test. The compiler
    // port is deliberately open so this checks the runner's evidence boundary.
    const item = { ...mutation(original, "loading", "", "EffectNever"), file: "src/loading.ts", replacement: { startOffset, endOffset: startOffset + "Effect.succeed(1)".length, text: "Effect.sync(() => { while (true) {} })" } };
    const report = yield* withPorts(runMutants({ ...config(dir.path), timeoutMultiplier: 2 }, Stream.make(item)), []);
    expect(report.results.map(r => r.outcome)).toEqual(["timeout"]);
  }).pipe(Effect.scoped, Effect.provide(live)), 15_000);

  it.live("catches a wrong account, misses the untested Frozen path, counts a hung Effect.never as caught, and leaves source bytes unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixtureFiles = [file, "test/account.test.ts", "package.json", "tsconfig.json", "README.md"];
      const before = yield* Effect.forEach(fixtureFiles, (name) => fs.readFile(`${root}/${name}`));
      const original = new TextDecoder().decode(before[0]);
      const start = original.indexOf("  if (account.frozen)");
      const end = original.indexOf("\n};", start);
      const body = original.slice(start, end);
      const reports: Array<RunReport> = [];
      const report = yield* withPorts(runMutants(config(), Stream.make(
        { ...mutation(original, "wrong-account", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"), file: `${root}/${file}` },
        mutation(original, "swallow-frozen", `  return (() => {${body}})().pipe(Effect.catchTag("Frozen", () => Effect.succeed(account)));`, "SwallowTag"),
        mutation(original, "never", '  process.stdout.write("mutant-never-pid=" + process.pid + "\\n"); return Effect.never;', "EffectNever")
      )), reports);
      expect(report.results.map((result) => result.outcome)).toEqual(["caught", "missed", "caught"]);
      expect(report.timeoutMs).toBe(20_000);
      expect(report.baseline.durationMs).toBeGreaterThan(0);
      expect(reports).toHaveLength(1);
      const timedOut = report.results.find((result) => result.mutant.genre === "EffectNever");
      const pid = /mutant-never-pid=(\d+)/.exec(timedOut?.output ?? "")?.[1];
      expect(pid).toBeDefined();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const alive = yield* spawner.exitCode(ChildProcess.make("ps", ["-p", pid ?? "0", "-o", "pid="]));
      expect(alive).not.toBe(0);
      const after = yield* Effect.forEach(fixtureFiles, (name) => fs.readFile(`${root}/${name}`));
      expect(after).toEqual(before);
    }).pipe(Effect.provide(live)), 30_000);

  it.live("restores the scratch bytes before a later mutant uses the same directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* fs.readFileString(`${root}/${file}`);
      const first = mutation(original, "wrong", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });");
      const width = first.replacement.endOffset - first.replacement.startOffset;
      const wrong = { ...first, replacement: { ...first.replacement, text: first.replacement.text.padEnd(width, " ") } };
      const offset = original.indexOf("account.balance === 0");
      const later: Mutant = { ...first, id: "unused-is-empty", functionName: "isEmpty", genre: "BooleanFlip", replacement: {
        startOffset: offset, endOffset: offset + "account.balance === 0".length, text: "true"
      } };
      const report = yield* withPorts(runMutants(config(), Stream.make(wrong, later)), []);
      expect(report.results.map((result) => result.outcome)).toEqual(["caught", "missed"]);
    }).pipe(Effect.provide(live)), 30_000);

  it.live("stops at a broken baseline without generating or testing mutants", () =>
    Effect.gen(function* () {
      const scratch = yield* Scratch;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch.acquire(root);
      const original = yield* fs.readFileString(`${root}/${file}`);
      yield* dir.apply(mutation(original, "broken", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"));
      let generated = false;
      const reports: RunReport[] = [];
      const result = yield* withPorts(runMutants(config(dir.path)), reports, {
        ...source, generate: () => Stream.fromEffect(Effect.sync(() => { generated = true; return mutation(original, "unused", ""); }))
      }).pipe(Effect.flip);
      expect(result._tag).toBe("BaselineFailed");
      expect(generated).toBe(false);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.failure).toContain("BaselineFailed");
      expect(reports[0]?.failure).toContain("vitest run");
      expect(reports[0]?.failure).toContain("expected");
    }).pipe(Effect.scoped, Effect.provide(live)), 30_000);

  it.live("isolates concurrent workers and skips tests for an unviable mutant", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* fs.readFileString(`${root}/${file}`);
      const start = original.indexOf("  if (account.frozen)");
      const end = original.indexOf("\n};", start);
      const body = original.slice(start, end);
      const report = yield* withPorts(runMutants({ ...config(), jobs: 2 }, Stream.make(
        mutation(original, "wrong", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"),
        mutation(original, "unviable", "  this is not TypeScript"),
        mutation(original, "swallow", `  return (() => {${body}})().pipe(Effect.catchTag("Frozen", () => Effect.succeed(account)));`, "SwallowTag")
      )), [], { ...source, checkViable: (mutant) => Effect.succeed({
        viable: mutant.id !== "unviable", diagnostics: mutant.id === "unviable" ? ["Invalid TypeScript"] : []
      }) });
      expect(Object.fromEntries(report.results.map((result) => [result.mutant.id, result.outcome]))).toEqual({
        wrong: "caught", unviable: "unviable", swallow: "missed"
      });
      expect(report.results.find((result) => result.mutant.id === "unviable")?.testCommand).toEqual([]);
    }).pipe(Effect.provide(live)), 30_000);

  it.live("writes completed results on interruption and releases every scratch directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* Scratch;
      const original = yield* fs.readFileString(`${root}/${file}`);
      const started = yield* Deferred.make<void>();
      const dirs: Array<string> = [];
      const reports: Array<RunReport> = [];
      const run = runMutants(config(), Stream.make(
        mutation(original, "wrong", "  return Effect.succeed({ id: 'wrong', balance: 0, frozen: false });"),
        mutation(original, "never", "  return Effect.never;", "EffectNever")
      )).pipe(
        Effect.provideService(MutantSource, source),
        Effect.provideService(Scratch, { acquire: (location) => scratch.acquire(location).pipe(Effect.tap((dir) => Effect.sync(() => { dirs.push(dir.path); }))) }),
        Effect.provideService(Reporter, {
          progress: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          write: (report) => Effect.sync(() => { reports.push(report); })
        })
      );
      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.results[0]?.outcome).toBe("caught");
      for (const dir of dirs) expect(yield* fs.exists(dir)).toBe(false);
    }).pipe(Effect.provide(live)), 30_000);
});
