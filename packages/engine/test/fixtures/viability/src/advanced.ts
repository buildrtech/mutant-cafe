import { Effect, Data, Schema } from "effect";
import { BoomError } from "./errors.ts";
export interface Status { readonly state: "on" | "off" }
export class NotFound extends Data.TaggedError("NotFound") {}
export const same = (): Effect.Effect<{ readonly state: "on" }> => Effect.succeed({ state: "on" });
export const read = (ok: boolean): Effect.Effect<Status, NotFound> => ok ? Effect.succeed({ state: "on" }) : Effect.fail(new NotFound());
export const imported = (): Effect.Effect<number, BoomError> => Effect.fail(new BoomError());
export const digest = (t: string) => t === "" ? Effect.fail(new NotFound()) : Effect.succeed(t.length);
export const checkAll = Effect.fn("checkAll")(function* inner(n: number) { if (!n) return yield* Effect.fail(new NotFound()); return n; });
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export const branded = () => Schema.decodeUnknownEffect(UserId)("u");
export const useBranded = () => branded().pipe(Effect.map(id => id.toUpperCase()));
export const reported = Effect.fn("reported")(function* (): Effect.fn.Return<Status> { return { state: "on" }; });
export const callback = Effect.gen(function* () { return (n: number) => n + 1; });
export const useCallback = () => callback.pipe(Effect.map(fn => fn(1)));
export const tag = (n: number): { reason: "alpha" | "zeta" } => ({ reason: n ? "zeta" : "alpha" });
