import { expect, it } from "vitest";
import { Effect } from "effect";
import * as s from "../src/shapes.ts";
import { Only, layerOnly } from "../src/layers-only.ts";

it("builds a Layer value, function and static Layer", async () => {
  expect(await Effect.runPromise(Only.pipe(Effect.provide(layerOnly)))).toEqual({ n: 1 });
  expect(await Effect.runPromise(s.NumberService.pipe(Effect.provide(s.live)))).toEqual({ n: 1 });
  expect(await Effect.runPromise(s.NumberService.pipe(Effect.provide(s.layerFunction())))).toEqual({ n: 1 });
  expect(await Effect.runPromise(s.StaticService.pipe(Effect.provide(s.StaticService.layer)))).toEqual({ n: 1 });
});
it("reaches internal functions and service methods", async () => {
  expect(s.useInternal(0)).toBe(1);
  expect(await Effect.runPromise(s.useEffect(1))).toBe(1);
  expect(await Effect.runPromise(s.useUntraced(1))).toBe(1);
  expect(await Effect.runPromise(Effect.gen(function* () {
    const service = yield* s.Greeter;
    return [yield* service.greet(1), yield* service.send(1)];
  }).pipe(Effect.provide(s.Greeter.layer)))).toEqual([1, 1]);
});
it("checks policy, guards and curried functions", () => {
  expect(s.policy.canEdit(1)).toBe(true);
  expect(s.allowed(1)).toBe(true);
  expect(s.guardFor("https:")("https://example.com")).toBe("send");
});
it("checks synthesized values", () => {
  expect(s.brand("real").length).toBeGreaterThan(0);
  expect(s.set().size).toBe(1);
  expect(s.map().size).toBe(1);
  expect(s.object(0).state).toBe("off");
  expect(s.identityCandidate(1, 0)).toBe(1);
  expect(s.identityGeneric<number>(1, 2, true)).toBe(1);
});
it("runs arrays and pipeables without asserting the negative path", async () => {
  expect(await Effect.runPromise(s.report(["a"]))).toEqual({ findings: [{ key: "a" }], pastDue: [] });
  expect(await Effect.runPromise(s.scoped(1))).toEqual({ _tag: "Done", n: 1 });
  expect(await Effect.runPromise(s.mapped(1))).toEqual({ _tag: "Mapped", n: 1 });
});
