import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}
export class Service extends Context.Service<Service, { readonly value: number }>()("test/Service") {}

/** @mutants-skip test skip */
export function skipped(): boolean { return true; }
/** @mutants-skip test arrow skip */
export const skippedArrow = (): boolean => false;

export function bool(): boolean { return true; }
export const literal = (): "red" | "blue" => "red";
export const numeric = (): number => 42;
export const words = (): string => "hello";
export const array = (): ReadonlyArray<number> => [42];
export const nothing = (): void => {};
export const option = (): Option.Option<number> => Option.some(42);
export const stream = (): Stream.Stream<number, Missing> => Stream.fail(new Missing({ id: "a" }));
export const layer = (): Layer.Layer<Service, Missing> => Layer.effect(Service, Effect.fail(new Missing({ id: "a" })));
export const generated = (): Effect.Effect<number, Missing> => Effect.gen(function* () {
  return yield* Effect.fail(new Missing({ id: "a" }));
});
export const named = Effect.fn("named")(function* (id: string) {
  if (!id) return yield* Effect.fail(new Missing({ id }));
  return 42;
});
export const program = Effect.gen(function* () {
  return yield* Effect.fail(new Missing({ id: "a" }));
});
type Maybe<T> = Option.Option<T>;
export const maybe = (): Maybe<number> => Option.some(42);
export const nested = (): Effect.Effect<Option.Option<number>> => Effect.succeed(Option.some(42));
export interface Impossible {
  readonly _tag: "Impossible";
  readonly perform: (value: string) => string;
}
export const synthetic = (): Effect.Effect<number, Impossible> => Effect.fail({ _tag: "Impossible", perform: (value) => value });

export class Counter {
  value(): boolean { return true; }
}
// A callback in an exported value is not itself an exported function.
export const mapped = [1, 2].map((value): number => value + 1);
// Not exported, so it is not a separate mutation target.
function privateFunction(): boolean { return true; }
void privateFunction;
