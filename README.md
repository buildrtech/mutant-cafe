# mutant.cafe

![MUTANT CAFE: a feral rat leaping a row of snap traps, some sprung and some not](https://raw.githubusercontent.com/joelhooks/mutant-cafe/main/assets/banner.jpg)

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

## Use it

Needs Node 24 or later, a `tsconfig.json`, and a vitest suite that passes.

```sh
npm install -D mutant-cafe
npx mutant-cafe --list      # preview the mutants
npx mutant-cafe --jobs 4    # test them
```

Run it from the package whose tests you want to check. In a monorepo that resolves workspace packages through built output, build the package's dependencies first.

| Flag | Meaning |
| --- | --- |
| `--list` | print the mutants and exit |
| `--in-diff <file>` | only mutants on lines a unified diff adds or changes |
| `--file <glob>`, `--exclude <glob>` | choose source files (repeatable) |
| `--jobs <n>` | scratch copies tested in parallel |
| `--timeout <s>` | per-mutant test timeout; default 5× the baseline run, at least 20 s |
| `--timeout-multiplier <x>`, `--minimum-test-timeout <s>` | tune that default |
| `--output <dir>` | results directory, default `mutants.out` |
| `--tsconfig <path>` | default `tsconfig.json` |

Results land in `mutants.out/`: `missed.txt`, `caught.txt`, `timeout.txt`, `unviable.txt`, a diff and a log per mutant, and `outcomes.json`. Add `mutants.out*` to `.gitignore`. Your source tree is never edited: each mutant runs in a scratch copy.

Exit codes: 0 every viable mutant was caught, 1 usage error, 2 some mutants were missed, 3 some timed out, 4 the baseline tests fail, 5 the `--in-diff` diff doesn't match the tree, 6 the diff can't be parsed, 70 internal error.

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
