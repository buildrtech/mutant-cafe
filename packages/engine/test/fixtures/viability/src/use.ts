import { Effect, Option } from "effect";
import { boom } from "./lib.ts";
export const twice = (n: number) => boom(n).pipe(Effect.map((x) => x * 2));
export const find = (k: string) => Effect.succeed(k ? Option.some({ _tag: "hit" as const, n: 1 }) : Option.none());
export const size = (k: string) => find(k).pipe(Effect.map(Option.map((h) => h.n)));
export const consume = (n: number) => twice(n).pipe(Effect.map((x) => x.toFixed()));
