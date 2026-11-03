import { Effect } from "effect";
let calls = 0;
export const next = () => ++calls;
export const value = () => Effect.succeed(1);
