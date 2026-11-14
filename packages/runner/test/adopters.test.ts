import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Scratch, TestRunner } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ScratchLive } from "../src/Scratch.ts";
import { TestRunnerLive } from "../src/TestRunner.ts";
import { preflight } from "../src/Preflight.ts";

// These proofs only copy files or reject setup. They never execute mutants.
const git = (root: string, args: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function* () {
  const child = yield* ChildProcess.make("git", ["-C", root, ...args], { stdin: "ignore" });
  const [code] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
  expect(Number(code)).toBe(0);
}));

for (const separate of [false, true]) it.live(`copies the Git file set and package dependency links without visiting ignored checkouts (${separate ? "gitfile" : "gitdir"})`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "scratch-git-" }));
  const root = `${parent}/project`;
  const packageRoot = `${root}/packages/library`;
  yield* fs.makeDirectory(`${packageRoot}/src`, { recursive: true });
  yield* git(root, ["init", "--quiet", ...(separate ? [`--separate-git-dir=${parent}/metadata`] : [])]);
  yield* fs.writeFileString(`${root}/.gitignore`, ".vendor/\nnode_modules/\nignored.txt\n");
  yield* fs.writeFileString(`${root}/ignored.txt`, "tracked despite ignore");
  yield* fs.writeFileString(`${root}/tsconfig.json`, "{}");
  yield* fs.writeFileString(`${packageRoot}/package.json`, '{"name":"library"}');
  yield* fs.writeFileString(`${packageRoot}/src/value.ts`, "export const value = 1;");
  yield* fs.symlink("src", `${packageRoot}/source-link`);
  yield* git(root, ["add", ".gitignore", "tsconfig.json", "packages/library/package.json", "packages/library/src/value.ts"]);
  yield* git(root, ["add", "--force", "ignored.txt"]);
  yield* fs.writeFileString(`${packageRoot}/src/untracked.ts`, "export const untracked = 2;");
  yield* fs.writeFileString(`${packageRoot}/src/space in name.ts`, "export const spaced = 3;");
  yield* fs.makeDirectory(`${root}/.vendor/checkout/node_modules`, { recursive: true });
  yield* fs.writeFileString(`${root}/.vendor/checkout/index.js`, "export const vendored = true;");
  yield* fs.symlink(`${root}/absent`, `${root}/.vendor/checkout/dangling`);
  yield* fs.makeDirectory(`${parent}/dependency`);
  yield* fs.writeFileString(`${parent}/dependency/index.js`, "export const dependency = true;");
  yield* fs.makeDirectory(`${root}/node_modules`);
  yield* fs.symlink(`${parent}/dependency`, `${root}/node_modules/dependency`);
  yield* fs.symlink(`${root}/.vendor/checkout`, `${root}/node_modules/vendored`);
  yield* fs.makeDirectory(`${packageRoot}/node_modules`);
  yield* fs.symlink(packageRoot, `${packageRoot}/node_modules/library`);
  const visited: string[] = [];
  const tracked: FileSystem.FileSystem = { ...fs, readDirectory: path => {
    if (path.startsWith(`${root}/.vendor`)) visited.push(path);
    return fs.readDirectory(path);
  } };
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked));
  const copied = yield* scratch.acquire(packageRoot);
  expect(copied.path).not.toBe(packageRoot);
  expect((yield* fs.lstat(`${copied.path}/source-link`)).type).toBe("Directory");
  yield* fs.writeFileString(`${copied.path}/source-link/value.ts`, "scratch only");
  expect(yield* fs.readFileString(`${packageRoot}/src/value.ts`)).toBe("export const value = 1;");
  expect(yield* fs.readFileString(`${copied.path}/src/value.ts`)).toBe("export const value = 1;");
  expect(yield* fs.readFileString(`${copied.path}/src/untracked.ts`)).toContain("untracked = 2");
  expect(yield* fs.readFileString(`${copied.path}/src/space in name.ts`)).toContain("spaced = 3");
  expect(yield* fs.readFileString(`${copied.path}/../../ignored.txt`)).toBe("tracked despite ignore");
  expect(yield* fs.readFileString(`${copied.path}/../../tsconfig.json`)).toBe("{}");
  expect(yield* fs.exists(`${copied.path}/../../.vendor`)).toBe(false);
  expect(visited).toEqual([]);
  expect(yield* fs.readFileString(`${copied.path}/../../node_modules/dependency/index.js`)).toContain("dependency = true");
  expect(yield* fs.readFileString(`${copied.path}/../../node_modules/vendored/index.js`)).toContain("vendored = true");
  expect(yield* fs.realPath(`${copied.path}/node_modules/library`)).toBe(copied.path);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("warns and skips dangling source and dependency symlinks outside Git while retaining ordinary files", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const original = yield* Console.Console;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scratch-links-" });
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  yield* fs.makeDirectory(`${root}/node_modules/@scope`, { recursive: true });
  for (const file of ["dangling", "node_modules/missing", "node_modules/@scope/missing"]) yield* fs.symlink(`${root}/absent`, `${root}/${file}`);
  const warnings: string[] = [];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner,
    { ...spawner, spawn: () => Effect.die("A non-Git project must not require a Git executable") }));
  const copied = yield* scratch.acquire(root).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  expect(yield* fs.readFileString(`${copied.path}/keep.txt`)).toBe("keep");
  for (const file of ["dangling", "node_modules/missing", "node_modules/@scope/missing"]) {
    expect(yield* fs.exists(`${copied.path}/${file}`)).toBe(false);
    expect((yield* fs.lstat(`${root}/${file}`)).type).toBe("SymbolicLink");
    expect(warnings.some(message => message.includes("skipped a dangling symlink") && message.endsWith(file))).toBe(true);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("rejects installed Vitest 4 during preflight and baseline with the actionable version message", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "vitest-version-" });
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module","scripts":{"test":"vitest run"}}');
  yield* fs.makeDirectory(`${root}/node_modules/vitest`, { recursive: true });
  yield* fs.writeFileString(`${root}/node_modules/vitest/package.json`, '{"name":"vitest","version":"4.1.12","exports":{"./package.json":"./package.json","./node":"./forbidden.mjs"},"bin":"./forbidden.mjs"}');
  yield* fs.writeFileString(`${root}/node_modules/vitest/forbidden.mjs`, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(`${root}/executed`)}, "unexpected"); throw new Error("must reject before import");`);
  const dir = { path: root, apply: () => Effect.void, revert: () => Effect.void };
  const results = [yield* preflight(root).pipe(Effect.result), yield* TestRunner.use(tests => tests.baseline(dir)).pipe(Effect.provide(TestRunnerLive), Effect.result)];
  for (const result of results) {
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("TestSpawnError");
      if (result.failure._tag === "TestSpawnError") {
        expect(result.failure.kind).toBe("vitest-version");
        expect(result.failure.message).toBe("mutant.cafe needs vitest >= 5.0, found 4.1.12");
      }
    }
  }
  expect(yield* fs.exists(`${root}/executed`)).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
