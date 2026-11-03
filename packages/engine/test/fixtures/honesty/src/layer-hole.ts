import { Context, Effect, Layer } from "effect";
class Input extends Context.Service<Input, { readonly read: () => Effect.Effect<number> }>()("Input") {}
declare const dynamic: any;
export const holeLayer = Layer.succeed(Input, dynamic<{ readonly read: () => Effect.Effect<number> }>());
