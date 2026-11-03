import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class Overdrawn extends Schema.TaggedError<Overdrawn>()("Overdrawn", {
  balance: Schema.Finite,
  amount: Schema.Finite,
}) {}

export class Frozen extends Schema.TaggedError<Frozen>()("Frozen", {
  accountId: Schema.String,
}) {}

export interface Account {
  readonly id: string;
  readonly balance: number;
  readonly frozen: boolean;
}

export const withdraw = (
  account: Account,
  amount: number
): Effect.Effect<Account, Overdrawn | Frozen> => {
  if (account.frozen) {
    return Effect.fail(new Frozen({ accountId: account.id }));
  }
  if (amount > account.balance) {
    return Effect.fail(new Overdrawn({ balance: account.balance, amount }));
  }
  return Effect.succeed({ ...account, balance: account.balance - amount });
};

export const isEmpty = (account: Account): boolean => account.balance === 0;
