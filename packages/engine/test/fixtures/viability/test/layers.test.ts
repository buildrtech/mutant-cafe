import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { First, Second, services } from "../src/layers.ts";

it.effect("builds both services", () => Effect.gen(function* () {
  const context = yield* Layer.build(services());
  expect(Context.get(context, First).value).toBe(1);
  expect(Context.get(context, Second).value).toBe(2);
}).pipe(Effect.scoped));
