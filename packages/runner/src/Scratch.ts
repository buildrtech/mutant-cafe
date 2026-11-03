import { Scratch, ScratchError, type Mutant, type ScratchDir } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export const ScratchLive = Layer.effect(Scratch, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failure = (operation: string, location: string, error: { readonly message: string }) =>
    new ScratchError({ operation, path: location, message: error.message });

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
        (dir) => fs.remove(dir, { recursive: true }).pipe(Effect.orDie)
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
                yield* fs.symlink(path.resolve(src), dest);
              } else {
                yield* copy(src, dest, [...ancestors, real]);
              }
            }
          } else if (info.type === "File") {
            yield* fs.copyFile(from, to);
          }
        }).pipe(Effect.mapError((error) => failure("copy", from, error)));
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
