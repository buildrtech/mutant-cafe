# fixture: tagged-errors

A deliberately incomplete suite. `withdraw` declares `Overdrawn | Frozen`; the tests cover success and `Overdrawn` but never `Frozen`, and never call `isEmpty`.

Expected from a mutant.cafe run:

- missed: `withdraw` swallowing `Frozen` (no test drives the frozen path), and both `isEmpty` mutants (no test calls it).
- caught: `withdraw` swallowing `Overdrawn`, `withdraw` replaced by `Effect.fail` of either tag, `Effect.die`, and `Effect.succeed` of a made-up account.
- timeout: `withdraw` replaced by `Effect.never`.
