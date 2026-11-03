import { Context, Layer } from "effect";

export class Only extends Context.Service<Only, { readonly n: number }>()("coverage/Only") {}
export const layerOnly = Layer.succeed(Only, { n: 1 });
export const idleOnly = Layer.succeed(Only, { n: 2 });
