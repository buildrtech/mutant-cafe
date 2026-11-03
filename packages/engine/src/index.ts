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
      for (const fn of discovered.functions) {
        const generated = [...generateFunction(fn)];
        if (!generated.length) notMutated.push({ file: fn.file, functionName: fn.name, reason: fn.skipReason ?? `opaque return or no synthesizable value: ${fn.displayReturnType}` });
        mutants.push(...generated);
      }
      return { mutants, notMutated };
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
