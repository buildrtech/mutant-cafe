import { Context, Data, Effect, Layer } from "effect";

export class First extends Context.Service<First, { readonly value: number }>()("fixture/First") {}
export class Second extends Context.Service<Second, { readonly value: number }>()("fixture/Second") {}
export class BuildError extends Data.TaggedError("BuildError") {}

export const services = (): Layer.Layer<First | Second, BuildError> => Layer.mergeAll(
  Layer.succeed(First, { value: 1 }),
  Layer.succeed(Second, { value: 2 }),
);
