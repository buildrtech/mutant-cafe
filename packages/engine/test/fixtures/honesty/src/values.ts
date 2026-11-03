import { Data, Effect, Match, Schema } from "effect";
import { hidden, type HiddenError } from "./hidden.ts";

class Conflict extends Data.TaggedError("Conflict") {}
export const service = { allowed: (_id: string): Effect.Effect<boolean, Conflict> => Effect.fail(new Conflict()) };
export const mode = (n: number): "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" => n ? "a" : "h";
export const always = (): boolean => true;
export const stable = Effect.fn(function* () { return true; });
export const json = (_key: string): Schema.Json | undefined => undefined;
export const collapse = (): { readonly a: 0 } | { readonly a: number } => ({ a: 1 });
export const Id = Schema.String.pipe(Schema.brand("Id"));
export type Id = typeof Id.Type;
type ParentId = Id & { readonly source?: "parent" };
export const shardId = (parent: ParentId, n: number): Id => `${parent}-${n}` as Id;
export const wider = (parent: Id): string => `${parent}-next`;
export const coordinates = (point: { readonly x: number; readonly y: number }): { readonly x: number } => ({ x: point.x + 1 });
export const label = (n: number): string => Match.value(n).pipe(
  Match.when(0, () => "zero"),
  Match.when(1, () => "one"),
  Match.orElse(() => "other"),
);
export const unavailable = (): Effect.Effect<boolean, HiddenError> => hidden();
export const inferredUnavailable = () => hidden();
class NeedsCallback extends Data.TaggedError("NeedsCallback")<{ readonly use: () => void }> {}
export const unbuildable = (): Effect.Effect<boolean, NeedsCallback> => Effect.fail(new NeedsCallback({ use: () => {} }));
const State = Schema.Struct({ context: Schema.Struct({ nested: Schema.Struct({ entry: Schema.Struct({ detail: Schema.Struct({ title: Schema.String, active: Schema.Boolean }) }) }) }), state: Schema.Literals(["idle", "active"]) });
export const state = (): typeof State.Type => ({ context: { nested: { entry: { detail: { title: "ready", active: true } } } }, state: "active" });
export const factory = (): { config: { run: () => void }; guards: { allowed: () => boolean } } => ({ config: { run: () => {} }, guards: { allowed: () => true } });
export const attempt = () => Effect.try({ try: () => "ok", catch: () => new Conflict() });
