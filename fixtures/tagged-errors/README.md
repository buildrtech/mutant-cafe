# fixture: tagged-errors

A deliberately incomplete suite. `withdraw` declares `Overdrawn | Frozen`; the tests cover success and `Overdrawn` but never `Frozen`, and never call `isEmpty`.

Expected from a mutant.cafe run:

- missed: `withdraw` swallowing `Frozen` (no test drives the frozen path), and both `isEmpty` mutants (no test calls it).
- caught: `withdraw` swallowing `Overdrawn`, `withdraw` replaced by `Effect.fail` of either tag, `Effect.die`, `Effect.succeed` of a made-up account, and `Effect.never` (the tests hang on it until the short per-mutant timeout, which counts as noticing).
