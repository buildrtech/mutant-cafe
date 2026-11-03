import { DiffParseError, type Mutant } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class DiffMismatch extends Schema.TaggedError<DiffMismatch>()("DiffMismatch", {
  path: Schema.String,
  message: Schema.String,
}) {}

interface NewLine { readonly number: number; readonly text: string; readonly added: boolean; readonly noNewline: boolean }
interface FilePatch { readonly file: string; readonly lines: ReadonlyArray<NewLine> }

// Counts, ordering and new-side text are checked, not merely the presence of @@.
export const parseDiff = (text: string, path: string) => Effect.try({
  try: (): ReadonlyArray<FilePatch> => {
    const fail = (message: string): never => { throw new DiffParseError({ path, message }); };
    if (text === "") return [];
    const input = text.split("\n");
    if (input.at(-1) === "") input.pop();
    const patches: FilePatch[] = [];
    let i = 0;
    let sawFile = false;
    while (i < input.length) {
      const line = input[i++]!;
      if (line.startsWith("diff --git ") || /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to )/.test(line)) continue;
      if (!line.startsWith("--- ")) fail("Expected a unified diff file header");
      const next = input[i++];
      if (!next?.startsWith("+++ ")) fail("Missing new-side file header");
      const raw = next!.slice(4).split("\t")[0]!;
      const decoded: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw;
      if (typeof decoded !== "string") fail("Invalid file path");
      const file = String(decoded).replace(/^b\//, "");
      const lines: NewLine[] = [];
      let hunks = 0;
      let previousEnd = 0;
      let previousOldEnd = 0;
      while (input[i]?.startsWith("@@")) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(input[i++]!);
        if (!match) fail("Invalid hunk header");
        let oldRemaining = Number(match![2] ?? 1);
        let newRemaining = Number(match![4] ?? 1);
        let newLine = Number(match![3]);
        const oldStart = Number(match![1]);
        const oldCount = oldRemaining;
        if (![oldStart, oldRemaining, newLine, newRemaining].every(Number.isSafeInteger)) fail("Hunk range is not a safe integer");
        if ((oldRemaining > 0 && oldStart === 0) || (newRemaining > 0 && newLine === 0)) fail("Nonempty hunk cannot start at zero");
        if (newLine < previousEnd || oldStart < previousOldEnd) fail("Overlapping or unordered hunks");
        let previousPrefix = "";
        const markNoNewline = () => {
          if (previousPrefix === "+" || previousPrefix === " ") {
            const last = lines.at(-1);
            if (last === undefined || last.noNewline) fail("Unexpected no-newline marker");
            lines[lines.length - 1] = { ...last!, noNewline: true };
          } else if (previousPrefix !== "-") fail("Unexpected no-newline marker");
          previousPrefix = "";
        };
        hunks++;
        while (oldRemaining > 0 || newRemaining > 0) {
          const body = input[i++];
          if (body === "\\ No newline at end of file") { markNoNewline(); continue; }
          if (body === undefined) fail("Truncated hunk");
          const prefix = body![0];
          if (prefix === " " || prefix === "-") oldRemaining--;
          if (prefix === " " || prefix === "+") {
            newRemaining--;
            lines.push({ number: newLine++, text: body!.slice(1), added: prefix === "+", noNewline: false });
          } else if (prefix !== "-") fail("Invalid hunk line");
          previousPrefix = prefix!;
          if (oldRemaining < 0 || newRemaining < 0) fail("Hunk count does not match its body");
        }
        if (input[i] === "\\ No newline at end of file") { markNoNewline(); i++; }
        previousEnd = newLine;
        previousOldEnd = oldStart + oldCount;
      }
      if (hunks === 0) fail("File has no hunks");
      sawFile = true;
      if (file !== "/dev/null") patches.push({ file, lines });
    }
    if (!sawFile) fail("No unified diff found");
    return patches;
  },
  catch: (error) => Schema.is(DiffParseError)(error) ? error : new DiffParseError({ path, message: String(error) }),
});

export const selectInDiff = Effect.fn("selectInDiff")(function*(options: {
  readonly root: string;
  readonly diffPath: string;
  readonly mutants: ReadonlyArray<Mutant>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const diffPath = path.resolve(options.root, options.diffPath);
  const text = yield* fs.readFileString(diffPath).pipe(Effect.mapError((error) => new DiffParseError({ path: diffPath, message: String(error) })));
  const patches = yield* parseDiff(text, diffPath);
  const changed = new Map<string, Set<number>>();
  for (const patch of patches) {
    const absolute = path.resolve(options.root, patch.file);
    const relative = path.relative(options.root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new DiffParseError({ path: diffPath, message: "Diff path escapes project root" });
    }
    const current = yield* fs.readFileString(absolute).pipe(Effect.mapError((error) => new DiffMismatch({ path: patch.file, message: String(error) })));
    const lines = current.split("\n");
    for (const line of patch.lines) {
      const finalLine = current.endsWith("\n") ? lines.length - 1 : lines.length;
      const newlineMismatch = line.noNewline
        ? line.number !== finalLine || current.endsWith("\n")
        : line.number === finalLine && !current.endsWith("\n");
      if (lines[line.number - 1] !== line.text || newlineMismatch) return yield* new DiffMismatch({ path: patch.file, message: `New-side line ${line.number} does not match tree` });
    }
    const added = changed.get(absolute) ?? new Set<number>();
    for (const line of patch.lines) if (line.added) added.add(line.number);
    changed.set(absolute, added);
  }
  return options.mutants.filter((mutant) => {
    const added = changed.get(path.resolve(options.root, mutant.file));
    const end = mutant.span.end.line - (mutant.span.end.column === 1 ? 1 : 0);
    return added !== undefined && [...added].some((line) => line >= mutant.span.start.line && line <= end);
  });
});
