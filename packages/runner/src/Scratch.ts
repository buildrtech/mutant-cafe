import { Scratch, ScratchError, type Mutant, type ScratchDir } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { poisonInsertion } from "./Poison.ts";

export const ScratchLive = Layer.effect(Scratch, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failure = (operation: string, location: string, error: { readonly message: string }) =>
    new ScratchError({ operation, path: location, message: error.message });

  const skipVanished = (from: string, to: string) => <E extends PlatformError.PlatformError | ScratchError>(effect: Effect.Effect<void, E>) => effect.pipe(Effect.catch(error => {
    if (error._tag !== "PlatformError" || error.reason._tag !== "NotFound") return Effect.fail(error);
    return Effect.gen(function* () {
      const entry = yield* fs.lstat(from).pipe(Effect.result);
      if (entry._tag === "Success") {
        if (entry.success.type !== "SymbolicLink") return yield* Effect.fail(error);
        const target = yield* fs.stat(from).pipe(Effect.result);
        if (target._tag === "Success") return yield* Effect.fail(error);
        if (target.failure.reason._tag !== "NotFound") return yield* Effect.fail(target.failure);
        yield* Console.warn(`Warning: scratch copy skipped a dangling symlink: ${from}`);
      } else if (entry.failure.reason._tag !== "NotFound") return yield* Effect.fail(entry.failure);
      // Only our partial destination is removed, never a source entry.
      yield* fs.remove(to, { recursive: true, force: true });
      yield* Effect.logDebug("Scratch copy skipped a vanished source", { source: from });
    });
  }));

  return Scratch.of({
    acquire: Effect.fn("Scratch.acquire")(function* (root: string) {
      let source = path.resolve(root);
      // Preserve workspace-relative tsconfig extends and local package imports.
      // Vitest still runs in the requested package, not at the workspace root.
      let copyRoot = source;
      let ancestor = source;
      while (true) {
        if ((yield* fs.exists(path.join(ancestor, "pnpm-workspace.yaml"))) || (yield* fs.exists(path.join(ancestor, ".git")))) {
          copyRoot = ancestor;
          break;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      const git = (args: ReadonlyArray<string>, cwd = source) => Effect.scoped(Effect.gen(function* () {
        const env = { ...process.env };
        for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
        const child = yield* spawner.spawn(ChildProcess.make("git", ["-C", cwd, ...args], { stdin: "ignore", env, extendEnv: false }));
        const [code, output] = yield* Effect.all([child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.stderr.pipe(Stream.runDrain)], { concurrency: "unbounded" });
        return { code, output };
      }));
      // Git is optional outside repositories. Do not make a non-Git project
      // depend on a Git executable merely to retain the recursive fallback.
      let gitAncestor = source;
      let inRepository = false;
      while (true) {
        if (yield* fs.exists(path.join(gitAncestor, ".git"))) { inRepository = true; break; }
        const parent = path.dirname(gitAncestor);
        if (parent === gitAncestor) break;
        gitAncestor = parent;
      }
      let selected: Set<string> | undefined;
      let directories: Set<string> | undefined;
      const originalSource = source;
      const originalCopyRoot = copyRoot;
      if (inRepository) yield* Effect.gen(function* () {
        const repository = yield* git(["rev-parse", "--show-toplevel"]);
        if (repository.code !== 0) return yield* new ScratchError({ operation: "git rev-parse", path: source, message: `Git exited ${repository.code}` });
        // Git returns physical paths (not /tmp aliases); use the same basis
        // before deriving the scratch package path or remapping self-links.
        source = yield* fs.realPath(source);
        copyRoot = path.resolve(repository.output.trim());
        const files = yield* git(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"], copyRoot).pipe(Effect.mapError(error => failure("git", source, error)));
        if (files.code !== 0) return yield* Effect.fail(new ScratchError({ operation: "git ls-files", path: source, message: `Git exited ${files.code}` }));
        selected = new Set(files.output.split("\0").filter(Boolean).map(file => path.resolve(copyRoot, file)));
        const ignored = yield* git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], copyRoot);
        if (ignored.code !== 0) return yield* new ScratchError({ operation: "git ls-files", path: source, message: `Git exited ${ignored.code}` });
        // Keep ignored environment, build and generated files. Only prune
        // independent ignored checkouts/dependency trees, never their contents.
        const independent = (dir: string): Effect.Effect<boolean, PlatformError.PlatformError> => Effect.gen(function* () {
          if ((yield* fs.exists(path.join(dir, ".git"))) || (yield* fs.exists(path.join(dir, "node_modules")))) return true;
          for (const name of yield* fs.readDirectory(dir)) {
            const child = path.join(dir, name);
            const info = yield* fs.lstat(child);
            if (info.type === "Directory" && (yield* independent(child))) return true;
          }
          return false;
        });
        for (const file of ignored.output.split("\0").filter(Boolean)) {
          const target = path.resolve(copyRoot, file);
          if (path.relative(copyRoot, target).split(path.sep).some(part => ["node_modules", ".git", "mutants.out", ".agent_sources", ".agent-sources", ".brain", ".pi", ".rift"].includes(part))) continue;
          const info = yield* fs.lstat(target).pipe(Effect.result);
          if (info._tag === "Failure") {
            if (info.failure.reason._tag === "NotFound") continue;
            return yield* info.failure;
          }
          if (info.success.type !== "Directory" || !(yield* independent(target))) selected.add(target);
        }
        // Ignored does not mean unused: a workspace dependency may export
        // prebuilt output. Preserve each declared entry's top-level tree so
        // relative imports and wildcard/conditional exports stay loadable.
        const PackageEntries = Schema.fromJsonString(Schema.Struct({
          exports: Schema.optional(Schema.Unknown), imports: Schema.optional(Schema.Unknown),
          main: Schema.optional(Schema.String), module: Schema.optional(Schema.String), types: Schema.optional(Schema.String)
        }));
        const targets = (entry: unknown): ReadonlyArray<string> => typeof entry === "string" ? [entry]
          : Array.isArray(entry) ? entry.flatMap(targets)
          : entry !== null && typeof entry === "object" ? Object.values(entry).flatMap(targets) : [];
        for (const file of [...selected]) {
          if (path.basename(file) !== "package.json" || !(yield* fs.exists(file))) continue;
          const decoded = yield* Schema.decodeEffect(PackageEntries)(yield* fs.readFileString(file)).pipe(Effect.result);
          if (decoded._tag === "Failure") {
            yield* Console.warn(`Warning: cannot inspect package entry points for scratch copying: ${file}`);
            continue;
          }
          const pkg = decoded.success;
          const root = path.dirname(file);
          const entries = [...targets(pkg.exports), ...targets(pkg.imports)].filter(entry => entry.startsWith("./"));
          entries.push(...[pkg.main, pkg.module, pkg.types].filter((entry): entry is string => entry !== undefined));
          for (const entry of entries) {
            const relative = path.relative(root, path.resolve(root, entry));
            if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
            const first = relative.split(path.sep)[0]!;
            if (!["node_modules", ".git"].includes(first)) selected.add(path.join(root, first));
          }
        }
        directories = new Set([copyRoot]);
        for (const file of selected) {
          let parent = path.dirname(file);
          while (parent !== copyRoot && parent !== path.dirname(parent)) { directories.add(parent); parent = path.dirname(parent); }
        }
      }).pipe(Effect.catch(error => Effect.gen(function* () {
        yield* Console.warn(`Warning: Git scratch discovery failed; using recursive copy: ${error.message}`);
        source = originalSource;
        copyRoot = originalCopyRoot;
        selected = undefined;
        directories = undefined;
      })));
      const temp = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "mutant-cafe-" }).pipe(
          Effect.mapError((error) => failure("create", source, error))),
        (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.interruptible, Effect.timeout(30_000), Effect.catch(error => Console.warn(`Warning: scratch removal did not complete within its cleanup budget: ${error.message}`, { path: dir })))
      );
      // Materialize source symlinks, except dependencies. No editable file in
      // the scratch tree may point back into the original checkout.
      const copy = (from: string, to: string, ancestors: ReadonlyArray<string>, filter = true): Effect.Effect<void, ScratchError> =>
        Effect.gen(function* () {
          const real = yield* fs.realPath(from);
          const info = yield* fs.stat(from);
          if (info.type === "Directory") {
            if (ancestors.includes(real)) {
              return yield* Effect.fail(new ScratchError({ operation: "copy", path: from, message: "Cyclic directory symlink" }));
            }
            yield* fs.makeDirectory(to, { recursive: true });
            const entries = yield* fs.readDirectory(from);
            for (const entry of entries) {
              if ([".git", "mutants.out", ".agent_sources", ".agent-sources", ".brain", ".pi", ".rift"].includes(entry)) continue;
              const src = path.join(from, entry);
              const dest = path.join(to, entry);
              // Never descend into ignored trees just to discover dependency folders.
              // Dependency links are needed only at the selected package ancestors.
              const filterChildren = filter && !selected?.has(from);
              if (filterChildren && selected && directories && !selected.has(src) && !directories.has(src) && entry !== "node_modules") continue;
              if (entry === "node_modules") {
                // Own the directory so workspace/self links can point at the
                // copied package. Linking node_modules wholesale sends tests
                // importing their package name back to the original checkout.
                const linkDependencies = (from: string, to: string): Effect.Effect<void, PlatformError.PlatformError> => Effect.gen(function* () {
                  yield* fs.makeDirectory(to, { recursive: true });
                  for (const name of yield* fs.readDirectory(from)) {
                    if ([".vite", ".vite-temp", ".vitest", ".cache"].includes(name)) continue;
                    const dependency = path.join(from, name);
                    const destination = path.join(to, name);
                    yield* Effect.gen(function* () {
                      if (name.startsWith("@")) {
                        yield* linkDependencies(dependency, destination);
                        return;
                      }
                      const realDependency = yield* fs.realPath(dependency);
                      const rel = path.relative(copyRoot, realDependency);
                      const inside = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !rel.split(path.sep).includes("node_modules")
                        && (!selected || selected.has(realDependency) || directories?.has(realDependency));
                      yield* fs.symlink(inside ? path.join(temp, rel) : realDependency, destination);
                    }).pipe(skipVanished(dependency, destination));
                  }
                });
                yield* linkDependencies(src, dest).pipe(skipVanished(src, dest));
              } else {
                yield* copy(src, dest, [...ancestors, real], filterChildren);
              }
            }
          } else if (info.type === "File") {
            yield* fs.copyFile(from, to);
          }
        }).pipe(skipVanished(from, to), Effect.mapError((error) => failure("copy", from, error)));
      yield* copy(copyRoot, temp, []);
      const packageRoot = yield* fs.realPath(path.join(temp, path.relative(copyRoot, source))).pipe(
        Effect.mapError((error) => failure("resolve", source, error)));

      const originals = new Map<string, Uint8Array>();
      const target = (mutant: Mutant) => Effect.gen(function* () {
        const relative = path.isAbsolute(mutant.file) ? path.relative(source, mutant.file) : mutant.file;
        const location = path.resolve(packageRoot, relative);
        const rel = path.relative(packageRoot, location);
        if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.split(path.sep).includes("node_modules")) {
          return yield* Effect.fail(new ScratchError({ operation: "resolve", path: mutant.file, message: "Mutant file must be inside the copied source tree" }));
        }
        const real = yield* fs.realPath(location).pipe(Effect.mapError((error) => failure("resolve", location, error)));
        const realRelative = path.relative(packageRoot, real);
        if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
          return yield* Effect.fail(new ScratchError({ operation: "resolve", path: mutant.file, message: "Mutant file resolves outside the scratch package" }));
        }
        return location;
      });
      const dir: ScratchDir = {
        path: packageRoot,
        apply: Effect.fn("Scratch.apply")(function* (mutant: Mutant) {
          const location = yield* target(mutant);
          const bytes = yield* fs.readFile(location);
          originals.set(location, bytes);
          const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
          const { startOffset, endOffset, text } = mutant.replacement;
          if (startOffset < 0 || endOffset < startOffset || endOffset > original.length) {
            return yield* Effect.fail(new ScratchError({ operation: "apply", path: location, message: "Replacement offsets are outside the file" }));
          }
          yield* fs.writeFileString(location, original.slice(0, startOffset) + text + original.slice(endOffset));
        }, (effect, mutant) => effect.pipe(Effect.mapError((error) => failure("apply", mutant.file, error)))),
        poison: Effect.fn("Scratch.poison")(function* (mutant: Mutant, signal: string, token: string) {
          const location = yield* target(mutant);
          const bytes = yield* fs.readFile(location).pipe(Effect.mapError(error => failure("probe", location, error)));
          const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
          const insertion = poisonInsertion(original, signal, token);
          yield* dir.apply({ ...mutant, replacement: { startOffset: insertion.offset, endOffset: insertion.offset, text: insertion.text } });
        }),
        revert: Effect.fn("Scratch.revert")(function* (mutant: Mutant) {
          const location = yield* target(mutant);
          const bytes = originals.get(location);
          if (bytes !== undefined) {
            yield* fs.writeFile(location, bytes);
            originals.delete(location);
          }
        }, (effect, mutant) => effect.pipe(Effect.mapError((error) => failure("revert", mutant.file, error))))
      };
      return dir;
    }, (effect, root) => effect.pipe(Effect.mapError((error) => error._tag === "ScratchError" ? error : failure("acquire", root, error))))
  });
}));
