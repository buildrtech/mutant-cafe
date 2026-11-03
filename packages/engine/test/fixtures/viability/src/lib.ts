import { Effect } from "effect";
import { BoomError } from "./errors.ts";
export const boom = (n: number): Effect.Effect<number, BoomError> => n ? Effect.succeed(n) : Effect.fail(new BoomError());
