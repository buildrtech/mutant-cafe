import { MutantSource, ProgramLoadError } from "@mutant-cafe/core";
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
  return {
    generate: (config) => Stream.unwrap(Effect.try({
      try: () => Stream.fromIterable({
        *[Symbol.iterator]() {
          for (const fn of oracle.discover(config)) yield* generateFunction(fn);
        },
      }),
      catch: (error) => loadError(config.tsconfig, error),
    })).pipe(
      // Iteration is synchronous compiler work; load it inside the typed error boundary.
      Stream.catchDefect((error) => Stream.fail(loadError(config.tsconfig, error))),
    ),
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
