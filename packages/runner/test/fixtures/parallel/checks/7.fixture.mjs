import { it, expect } from "vitest";
import { Effect } from "effect";
import { setTimeout } from "node:timers/promises";
import { next, value } from "../src/value.ts";
it("isolates the singleton in file 7", () => expect(next()).toBe(1));
it("checks the target in file 7", async () => { await setTimeout(500); expect(await Effect.runPromise(value())).toBe(1); });
