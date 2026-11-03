import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { withdraw } from "../src/account.ts";

const open = { id: "a1", balance: 100, frozen: false };

describe("withdraw", () => {
  it.effect("takes the amount off the balance", () =>
    Effect.gen(function* () {
      const after = yield* withdraw(open, 30);
      expect(after.balance).toBe(70);
    })
  );

  it.effect("refuses to overdraw", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(withdraw(open, 500));
      expect(error._tag).toBe("Overdrawn");
    })
  );
});
