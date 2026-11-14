import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type { Mutant, NotMutated } from "./Mutant.ts";

/** One boundary-aware linked-file decision for CLI budgets and runner safety. */
export const excludeLinkedCandidates = Effect.fn("Selection.excludeLinkedCandidates")(function* (
  root: string, candidates: ReadonlyArray<Mutant>, linkedRoots: ReadonlyArray<string>
) {
  const path = yield* Path.Path;
  const mutants: Mutant[] = [];
  const skipped: NotMutated[] = [];
  for (const mutant of candidates) {
    const file = path.isAbsolute(mutant.file) ? path.relative(root, mutant.file) : mutant.file;
    const linked = linkedRoots.some(link => {
      const relative = path.relative(link, file);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
    if (linked) skipped.push({ file: path.resolve(root, file), functionName: mutant.functionName, span: mutant.span,
      reason: "Source is in a linked ignored tree; original files are not mutation targets" });
    else mutants.push(mutant);
  }
  return { mutants, notMutated: [...new Map(skipped.map(entry => [JSON.stringify(entry), entry])).values()] };
});
