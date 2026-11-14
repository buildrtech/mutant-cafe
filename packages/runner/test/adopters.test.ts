import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Scratch, TestRunner } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ScratchLive } from "../src/Scratch.ts";
import { TestRunnerLive } from "../src/TestRunner.ts";
import { preflight } from "../src/Preflight.ts";
import { builtWorkspace } from "./WorkspaceOutput.ts";

// These proofs only copy files or reject setup. They never execute mutants.
const git = (root: string, args: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function* () {
  const child = yield* ChildProcess.make("git", ["-C", root, ...args], { stdin: "ignore" });
  const [code] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
  expect(Number(code)).toBe(0);
}));

for (const separate of [false, true]) it.live(`copies the Git file set and package dependency links without traversing independent ignored checkouts (${separate ? "gitfile" : "gitdir"})`, () => Effect.gen(function* () {
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
  expect((yield* fs.lstat(`${copied.path}/../../.vendor`)).type).toBe("SymbolicLink");
  expect(yield* fs.realPath(`${copied.path}/../../.vendor`)).toBe(`${root}/.vendor`);
  expect(yield* fs.readFileString(`${copied.path}/../../.vendor/checkout/index.js`)).toContain("vendored = true");
  expect(visited.some(path => path.includes("/.vendor/checkout"))).toBe(false);
  expect(yield* fs.readFileString(`${copied.path}/../../node_modules/dependency/index.js`)).toContain("dependency = true");
  expect(yield* fs.readFileString(`${copied.path}/../../node_modules/vendored/index.js`)).toContain("vendored = true");
  expect(yield* fs.realPath(`${copied.path}/node_modules/library`)).toBe(copied.path);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("preserves ignored workspace exports, generated files and environment without traversing independent checkouts", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root, consumer, library, artifacts } = yield* builtWorkspace(true);
  const visited: string[] = [];
  const tracked: FileSystem.FileSystem = { ...fs, readDirectory: path => {
    if (path.startsWith(`${root}/.vendor`)) visited.push(path);
    return fs.readDirectory(path);
  } };
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked));
  const copied = yield* scratch.acquire(consumer);
  const copiedLibrary = yield* fs.realPath(`${copied.path}/../../node_modules/@fixture/library`);
  expect(copiedLibrary).not.toBe(library);
  expect(copiedLibrary).toBe(yield* fs.realPath(`${copied.path}/../library`));
  for (const [file, text] of Object.entries(artifacts)) expect(yield* fs.readFileString(`${copiedLibrary}/${file}`), file).toBe(text);
  expect(yield* fs.readFileString(`${copied.path}/.env.test`)).toBe("VITE_FIXTURE_VALUE=present\n");
  expect((yield* fs.lstat(`${copied.path}/../../.vendor`)).type).toBe("SymbolicLink");
  expect(yield* fs.realPath(`${copiedLibrary}/dist`)).not.toBe(`${library}/dist`);
  yield* fs.writeFileString(`${copiedLibrary}/dist/index.js`, "scratch only");
  expect(yield* fs.readFileString(`${library}/dist/index.js`)).toBe(artifacts["dist/index.js"]);
  expect(visited.some(path => path.includes("/.vendor/checkout"))).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

for (const phase of ["readDirectory", "child-lstat", "ignored-lstat"] as const) it.live(`prunes unreadable ignored trees with a warning instead of falling back (${phase})`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const console = yield* Console.Console;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "ignored-permissions-" }));
  yield* git(root, ["init", "--quiet"]);
  yield* fs.writeFileString(`${root}/.gitignore`, "docker-data/\n");
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  yield* fs.makeDirectory(`${root}/docker-data/postgres`, { recursive: true });
  yield* fs.writeFileString(`${root}/docker-data/postgres/data`, "not scratch input");
  const denied = `${root}/docker-data${phase === "ignored-lstat" ? "" : "/postgres"}`;
  const permission = (method: string) => Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({
    _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: denied
  })));
  const tracked: FileSystem.FileSystem = { ...fs,
    readDirectory: path => phase === "readDirectory" && path === denied ? permission("readDirectory") : fs.readDirectory(path),
    lstat: path => phase !== "readDirectory" && path === denied ? permission("lstat") : fs.lstat(path)
  };
  const warnings: string[] = [];
  const copied = yield* Scratch.use(scratch => scratch.acquire(root)).pipe(Effect.provide(ScratchLive),
    Effect.provideService(FileSystem.FileSystem, tracked),
    Effect.provideService(Console.Console, { ...console, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  expect(yield* fs.readFileString(`${copied.path}/keep.txt`)).toBe("keep");
  expect(yield* fs.exists(`${copied.path}/docker-data`)).toBe(false);
  expect(warnings.some(message => message.includes("skipped an unreadable ignored tree"))).toBe(true);
  expect(warnings.some(message => message.includes("using recursive copy"))).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("retains relative vendor paths without walking them and refuses mutation through their links", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "linked-vendor-" }));
  yield* git(root, ["init", "--quiet"]);
  yield* fs.writeFileString(`${root}/.gitignore`, ".vendor/\n");
  yield* fs.makeDirectory(`${root}/.vendor/shared/node_modules`, { recursive: true });
  const original = "export const value = 1;";
  yield* fs.writeFileString(`${root}/.vendor/shared/value.ts`, original);
  yield* fs.writeFileString(`${root}/.vendor/shared/tsconfig.json`, '{"compilerOptions":{"strict":true}}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, '{"extends":"./.vendor/shared/tsconfig.json","compilerOptions":{"paths":{"shared/*":["./.vendor/shared/*"]}}}');
  const visited: string[] = [];
  const tracked: FileSystem.FileSystem = { ...fs, readDirectory: path => {
    if (path.startsWith(`${root}/.vendor/shared`)) visited.push(path);
    return fs.readDirectory(path);
  } };
  const scratch = yield* Scratch.use(Effect.succeed).pipe(Effect.provide(ScratchLive), Effect.provideService(FileSystem.FileSystem, tracked));
  const copied = yield* scratch.acquire(root);
  expect(yield* fs.realPath(`${copied.path}/.vendor/shared/value.ts`)).toBe(`${root}/.vendor/shared/value.ts`);
  expect(yield* fs.readFileString(`${copied.path}/.vendor/shared/tsconfig.json`)).toContain('"strict":true');
  const attempted = yield* copied.apply({ id: "outside", file: ".vendor/shared/value.ts", functionName: "value", returnType: "number", genre: "FnValue",
    description: "must refuse external target", synthetic: false, span: { start: { line: 1, column: 1 }, end: { line: 1, column: 24 } },
    replacement: { startOffset: 21, endOffset: 22, text: "2" } }).pipe(Effect.result);
  expect(attempted._tag).toBe("Failure");
  if (attempted._tag === "Failure") expect(attempted.failure.message).toContain("resolves outside the scratch package");
  expect(yield* fs.readFileString(`${root}/.vendor/shared/value.ts`)).toBe(original);
  const linkedPackage = yield* scratch.acquire(`${root}/.vendor/shared`).pipe(Effect.result);
  expect(linkedPackage._tag).toBe("Failure");
  if (linkedPackage._tag === "Failure") expect(linkedPackage.failure.message).toContain("refusing to mutate the original checkout");
  expect(visited).toEqual([]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

for (const phase of ["spawn", "rev-parse", "ls-files", "ignored-ls-files"] as const) it.live(`warns and copies recursively when Git discovery fails (${phase})`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const console = yield* Console.Console;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "git-fallback-" }));
  yield* git(root, ["init", "--quiet"]);
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  const warnings: string[] = [];
  let failed = 0;
  const tracked: ChildProcessSpawner.ChildProcessSpawner["Service"] = { ...spawner, spawn: command => {
    const match = command._tag === "StandardCommand" && command.command === "git" && (phase === "spawn"
      || (phase === "rev-parse" && command.args.includes("rev-parse"))
      || (phase === "ls-files" && command.args.includes("ls-files") && !command.args.includes("--ignored"))
      || (phase === "ignored-ls-files" && command.args.includes("--ignored")));
    if (!match) return spawner.spawn(command);
    failed++;
    return phase === "spawn" ? Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({
      _tag: "NotFound", module: "ChildProcess", method: "spawn", pathOrDescriptor: "git"
    }))) : spawner.spawn(ChildProcess.make(process.execPath, ["-e", "process.exit(128)"], command.options));
  } };
  const copied = yield* Scratch.use(scratch => scratch.acquire(root)).pipe(Effect.provide(ScratchLive),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, tracked),
    Effect.provideService(Console.Console, { ...console, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  expect(failed).toBe(1);
  expect(yield* fs.readFileString(`${copied.path}/keep.txt`)).toBe("keep");
  expect(warnings.some(message => message.includes("Git scratch discovery failed; using recursive copy"))).toBe(true);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("does not let inherited Git hook variables change the discovered work tree", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "git-environment-" }));
  yield* git(root, ["init", "--quiet"]);
  yield* fs.writeFileString(`${root}/keep.txt`, "keep");
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  const options: ChildProcess.CommandOptions[] = [];
  const tracked: ChildProcessSpawner.ChildProcessSpawner["Service"] = { ...spawner, spawn: command => {
    if (command._tag === "StandardCommand" && command.command === "git") options.push(command.options);
    return spawner.spawn(command);
  } };
  yield* Effect.acquireUseRelease(Effect.sync(() => { for (const key of keys) process.env[key] = `${root}/not-a-repository`; }),
    () => Effect.gen(function* () {
      const copied = yield* Scratch.use(scratch => scratch.acquire(root)).pipe(Effect.provide(ScratchLive), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, tracked));
      expect(yield* fs.readFileString(`${copied.path}/keep.txt`)).toBe("keep");
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect(option.extendEnv).toBe(false);
        for (const key of keys) expect(option.env?.[key]).toBeUndefined();
      }
    }), () => Effect.sync(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }));
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
