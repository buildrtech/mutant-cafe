import { it, expect } from "vitest";
import { Effect } from "effect";
import { next, value } from "../src/value.ts";
import { setTimeout } from "node:timers/promises";
it("resets module singleton", () => expect(next()).toBe(1));
it("runs the affected effect", async () => expect(await Effect.runPromise(value())).toBe(1));
for (let i = 0; i < 3; i++) it(`slow ${i}`, async () => { await setTimeout(1500); expect(await Effect.runPromise(value())).toBe(1); });
