import { it, expect } from "vitest";
import { Effect } from "effect";
import { next, value } from "../src/value.ts";
import { other } from "../src/other.ts";
it("has a fresh singleton in a second file", () => expect(next()).toBe(1));
it("sees the restored value on an unrelated mutation", async () => { expect(await Effect.runPromise(value())).toBe(1); expect(other()).toBe(true); });
