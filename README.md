# mutant.cafe

> Draft. Not released.

Mutation testing for [Effect](https://effect.website) TypeScript. mutant.cafe reads your types, breaks your functions in ways that still type-check, runs the tests related to each break, and lists the breaks your tests miss.

It is inspired by [cargo-mutants](https://mutants.rs) by Martin Pool ([source](https://github.com/sourcefrog/cargo-mutants), MIT). The core idea, replacing a function body with a plausible value of its return type and reporting what the tests don't notice, comes from cargo-mutants, and so does the operator experience: a baseline run first, a scratch copy of your tree, per-mutant timeouts, `--in-diff`, and a `mutants.out` directory of results. mutant.cafe ports those ideas to Effect; it shares no code with cargo-mutants.

## What it adds for Effect

An `Effect<A, E, R>` declares its failures in `E`. For each tagged error in `E`, mutant.cafe makes a mutant that swallows that error and succeeds instead. If your tests still pass, no test drives that failure path.

Other mutants, all chosen from the checker's view of the return type:

- `Effect.succeed(value)` for plausible values of `A`, `Effect.fail` of each tag, `Effect.die`, and `Effect.never` behind a short timeout
- `Option.none()` and `Option.some(value)`
- `Stream.empty`, a one-element stream, and a failing stream
- a `Layer` that fails at build
- flipped booleans and cycled literal unions

## Outcomes

| Outcome | Meaning |
| --- | --- |
| caught | a related test failed |
| missed | every related test passed |
| unviable | the mutant does not type-check |
| timeout | the tests ran past the per-mutant timeout |

## Prior art

[StrykerJS](https://stryker-mutator.io) and its Effect 4 fork [stryker-js-effect](https://github.com/systemfsoftware/stryker-js-effect) mutate syntax (operators, literals, blocks, and some Effect concurrency faults) and use the type checker to discard mutants that don't compile. mutant.cafe uses the checker to generate mutants from types instead. Use both if you like; they find different gaps.

## License

MIT
