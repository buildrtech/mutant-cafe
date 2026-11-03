# mutant.cafe

![MUTANT CAFE: a feral rat leaping a row of snap traps, some sprung and some not](https://raw.githubusercontent.com/joelhooks/mutant-cafe/main/assets/banner.jpg)

Mutation testing for [Effect](https://effect.website) TypeScript. mutant.cafe reads your types, breaks your functions in ways that still type-check, runs the tests related to each break, and lists the breaks your tests miss.

It is inspired by [cargo-mutants](https://mutants.rs) by Martin Pool ([source](https://github.com/sourcefrog/cargo-mutants), MIT). The core idea, replacing a function body with a plausible value of its return type and reporting what the tests don't notice, comes from cargo-mutants, and so does the operator experience: a baseline run first, a scratch copy of your tree, per-mutant timeouts, `--in-diff`, and a `mutants.out` directory of results. mutant.cafe ports those ideas to Effect; it shares no code with cargo-mutants.

## What it adds for Effect

An `Effect<A, E, R>` declares its failures in `E`. For each tagged error in `E`, mutant.cafe makes a mutant that swallows that error and succeeds instead. If no value of `A` can be synthesized, a separate `TagToDefect` mutant turns that tag into a defect. That is not a successful recovery: it checks whether tests distinguish typed failures from defects, rather than only asserting `Exit.isFailure`.

Other mutants, all chosen from the checker's view of the return type:

- `Effect.succeed(value)` for plausible values of `A`, `Effect.fail` of each tag, `Effect.die`, and `Effect.never` behind a measured timeout
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
| `--list` | print the mutants, per-file counts and a total, then exit |
| `--in-diff <file>` | only mutants on lines a unified diff adds or changes |
| `--file <glob>`, `--exclude <glob>` | choose source files (repeatable) |
| `--jobs <n>` | scratch copies tested in parallel |
| `--timeout <s>` | per-mutant test timeout; default 5× the baseline run, at least 20 s |
| `--timeout-multiplier <x>`, `--minimum-test-timeout <s>` | tune that default |
| `--output <dir>` | results directory, default `mutants.out` |
| `--tsconfig <path>` | default `tsconfig.json` |

Results land in `mutants.out/`: `missed.txt`, `caught.txt`, `timeout.txt`, `unviable.txt`, `untested.txt`, a context diff and a log per mutant, and `outcomes.json`. Every result line includes the mutant id used by `diff/<id>.diff` and `logs/<id>.log`. Lines show the declared return type when available, or an abbreviated inferred type; JSON keeps full types. Add `mutants.out*` to `.gitignore`. Your source tree is never edited: each mutant runs in a scratch copy.

An include glob that matches no source file is a usage error, including a path outside the package root. Diff paths resolve from the Git toplevel, with support for `git diff --relative`; outside Git they resolve from the working directory.

Exit codes: 0 no missed, untested or timed-out mutants, 1 usage error, 2 some mutants were missed or untested, 3 some timed out with none missed or untested, 4 the baseline tests fail, 5 the `--in-diff` diff doesn't match the tree, 6 the diff can't be parsed, 70 internal error. **Missed or untested takes precedence over timeout:** a run with both exits 2.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| caught | a test failed, or a collected test run hung on `Effect.never` past its measured budget |
| missed | the selected tests passed |
| unviable | the mutant does not type-check |
| timeout | the tests ran past the per-mutant budget without a reported failure or evidence of a caught `Effect.never` |
| untested | neither related selection nor the package's full suite found any test files |

Vitest first runs tests related to the mutated file. When that selects no test files, mutant.cafe reruns the package's full suite within the remaining budget. Selection and partial failures come from Vitest's reporter hooks, not its human-readable messages. A reported failure still counts as caught if another test file hangs.

Ordinary mutants use the configured timeout. For `Effect.never`, mutant.cafe measures the unmutated related run once per file, including any full-suite fallback. Its budget is that duration × the timeout multiplier, with a 1 s floor. Slow tests that never call the function can finish normally; a process killed before test collection is not credited as caught. Each mutant run also sets Vitest's per-test timeout to half its budget, overriding a package's `testTimeout: 0`, and stops after the first reported failure.

## Prior art

[StrykerJS](https://stryker-mutator.io) and its Effect 4 fork [stryker-js-effect](https://github.com/systemfsoftware/stryker-js-effect) mutate syntax (operators, literals, blocks, and some Effect concurrency faults) and use the type checker to discard mutants that don't compile. mutant.cafe uses the checker to generate mutants from types instead. Use both if you like; they find different gaps.

## License

MIT
