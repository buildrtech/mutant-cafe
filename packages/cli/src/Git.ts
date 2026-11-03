import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {}

export const git = Effect.fn("git")(function*(root: string, args: ReadonlyArray<string>) {
  const command = `git ${args.join(" ")}`;
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* ChildProcess.make("git", args, { cwd: root });
    const [stdout, stderr, code] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode,
    ], { concurrency: "unbounded" });
    if (Number(code) !== 0) return yield* new UsageError({ message: `${command}:\n${stderr}` });
    return stdout;
  })).pipe(Effect.mapError(error => error._tag === "UsageError" ? error : new UsageError({ message: `${command}: ${String(error)}` })));
});

export const repositoryRoot = Effect.fn("repositoryRoot")(function*(root: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const top = (yield* git(root, ["rev-parse", "--show-toplevel"])).trim();
  const physical = yield* fs.realPath(root).pipe(Effect.mapError(error => new UsageError({ message: String(error) })));
  return path.resolve(root, path.relative(physical, top));
});
