import { MutantSource, ProgramLoadError, type Mutant, type NotMutated, type RunConfig } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { generateFunction } from "./Generate.ts";
import type { TypeOracle } from "./TypeOracle.ts";
import { makeTypeScriptOracle } from "./TypeScriptOracle.ts";

export { makeTypeScriptOracle } from "./TypeScriptOracle.ts";
export type { TypeOracle } from "./TypeOracle.ts";

/** Each layer build owns its warm compiler and original-source cache. */
export const MutantSourceLive: Layer.Layer<MutantSource> = Layer.effect(
  MutantSource,
  Effect.sync(() => makeMutantSource(makeTypeScriptOracle())),
);

export function makeMutantSource(oracle: TypeOracle): MutantSource["Service"] {
  // Discovery results belong to the call, not to the warm compiler. Asking for
  // another selection cannot clear a caller's skips or partially consumed stream.
  const discover = (config: RunConfig) => Effect.try({
    try: () => {
      const discovered = oracle.discover(config);
      const notMutated: NotMutated[] = [...discovered.notMutated];
      const mutants: Mutant[] = [];
      const failed = new Set<typeof discovered.functions[number]>();
      const generatedFunctions = discovered.functions.map(fn => {
        try { return { fn, generated: [...generateFunction(fn)] }; }
        catch (error) {
          failed.add(fn);
          if (fn.functionLike !== false) notMutated.push({ file: fn.file, functionName: fn.name, span: fn.functionSpan ?? fn.span,
            reason: `analysis failed: ${error instanceof Error ? error.message : String(error)}` });
          return { fn, generated: [] };
        }
      });
      for (const { fn, generated } of generatedFunctions) {
        if (failed.has(fn)) continue;
        if (fn.functionLike !== false) {
          const reasons = [...(fn.notices ?? [])];
          if (!generated.length && !reasons.length) reasons.push(fn.skipReason ?? `return not synthesizable (type ${fn.displayReturnType})`);
          const innerMutated = !generated.length && generatedFunctions.some(({ fn: inner, generated }) => inner.file === fn.file && inner.startOffset > fn.startOffset
            && inner.endOffset < fn.endOffset && generated.length > 0);
          if (innerMutated && !generated.length) {
            for (let i = 0; i < reasons.length; i++) if (reasons[i]!.startsWith("return not synthesizable")) reasons[i] += "; inner functions mutated";
          }
          if (reasons.length) notMutated.push({ file: fn.file, functionName: fn.name, span: fn.functionSpan ?? fn.span, reason: [...new Set(reasons)].join("; ") });
        }
        mutants.push(...generated);
      }
      return { mutants, notMutated: [...new Map(notMutated.map(item => [JSON.stringify(item), item])).values()] };
    },
    catch: (error) => loadError(config.tsconfig, error),
  });
  return {
    notMutated: (config) => discover(config).pipe(Effect.map(result => result.notMutated)),
    generate: (config) => Stream.unwrap(discover(config).pipe(Effect.map(result => Stream.fromIterable(result.mutants)))),
    checkViable: (mutant) => Effect.try({
      try: () => oracle.checkViable(mutant),
      catch: (error) => loadError("", error),
    }),
  };
}

function loadError(tsconfig: string, error: unknown): ProgramLoadError {
  return Schema.is(ProgramLoadError)(error) ? error : new ProgramLoadError({
    tsconfig, diagnostics: [error instanceof Error ? error.message : String(error)],
  });
}
