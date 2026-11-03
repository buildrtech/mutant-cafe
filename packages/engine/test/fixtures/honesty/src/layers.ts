import { Context, Data, Effect, Layer } from "effect";
class ReadProblem extends Data.TaggedError("ReadProblem")<{ readonly call: () => void }> {}
class Input extends Context.Service<Input, { readonly read: () => Effect.Effect<number> }>()("Input") {}
class Output extends Context.Service<Output, { readonly write: (n: number) => Effect.Effect<void> }>()("Output") {}
const defaults = Layer.succeed(Output, { write: (_n: number) => Effect.void });
export const configLayer = (entries: readonly number[]) => Layer.merge(defaults, Layer.effect(Input, Effect.gen(function* () {
  if (!entries.length) return yield* new ReadProblem({ call: () => {} });
  return { read: () => Effect.succeed(entries[0]!) };
})));
export const memoryLayer = (entries: readonly number[]) => Layer.unwrap(Effect.gen(function* () {
  if (!entries.length) return yield* new ReadProblem({ call: () => {} });
  return Layer.merge(defaults, Layer.succeed(Input, { read: () => Effect.succeed(entries[0]!) }));
}));
export const controlLayer = (n: number) => {
  const guarded = Layer.effect(Input, Effect.gen(function* () { return { read: () => Effect.succeed(n) }; })).pipe(Layer.provide(defaults));
  return Layer.merge(guarded, defaults);
};
export const combined = Layer.merge(configLayer([1]), memoryLayer([2]));
/** @mutants-skip */
export const excludedLayer = combined;
const internalLayer = Layer.succeed(Input, { read: () => Effect.succeed(1) });
export const useInternal = () => internalLayer;
