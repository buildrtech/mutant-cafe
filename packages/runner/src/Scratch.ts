import { Scratch, ScratchError, type Mutant, type ScratchDir } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { poisonInsertion } from "./Poison.ts";

export const ScratchLive = Layer.effect(Scratch, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failure = (operation: string, location: string, error: { readonly message: string }) =>
    new ScratchError({ operation, path: location, message: error.message });

  const skipVanished = (from: string, to: string) => <E extends PlatformError.PlatformError | ScratchError>(effect: Effect.Effect<void, E>) => effect.pipe(Effect.catch(error => {
    if (error._tag !== "PlatformError" || error.reason._tag !== "NotFound") return Effect.fail(error);
    return Effect.gen(function* () {
      if (yield* fs.exists(from)) return yield* Effect.fail(error);
      // Only our partial destination is removed, never a source entry.
      yield* fs.remove(to, { recursive: true, force: true });
      yield* Effect.logDebug("Scratch copy skipped a vanished source", { source: from });
    });
  }));

  return Scratch.of({
    acquire: Effect.fn("Scratch.acquire")(function* (root: string) {
      const source = path.resolve(root);
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
      const temp = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "mutant-cafe-" }).pipe(
          Effect.mapError((error) => failure("create", source, error))),
        (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.interruptible, Effect.timeout(2000), Effect.catch(error => Effect.logWarning(`Scratch removal did not complete within its cleanup budget: ${error.message}`, { path: dir })))
      );
      // Materialize source symlinks, except dependencies. No editable file in
      // the scratch tree may point back into the original checkout.
      const copy = (from: string, to: string, ancestors: ReadonlyArray<string>): Effect.Effect<void, ScratchError> =>
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
                      const inside = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !rel.split(path.sep).includes("node_modules");
                      yield* fs.symlink(inside ? path.join(temp, rel) : realDependency, destination);
                    }).pipe(skipVanished(dependency, destination));
                  }
                });
                yield* linkDependencies(src, dest).pipe(skipVanished(src, dest));
              } else {
                yield* copy(src, dest, [...ancestors, real]);
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
