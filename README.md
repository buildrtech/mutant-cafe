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
- a `Layer` that dies at build, even when its error type is `never`, plus one failing build per error tag
- flipped booleans and cycled literal unions

## Use it

Needs Node 24 or later, a `tsconfig.json`, and a vitest suite that passes.

```sh
npm install -D mutant-cafe
npx mutant-cafe --list      # preview the mutants
npx mutant-cafe --jobs 4    # test them
```

It mutates internal functions by default, including `Effect.fn` and `Effect.fnUntraced`, object-literal arrows, service methods inside Layers, and the inner function of a curried export. Layer values and static Layer properties are targets too. Names follow their path, such as `Greeter.layer.greet`, `policy.canEdit`, and `guardFor.<inner>`. With `--exported-only`, targets must be reachable through an exported binding path: exported top-level functions, methods and functions in exported values, returned curried functions, and exported Layers with their returned service methods. Local declarations and arrows inside other function bodies are internal, even if their owner is exported. This keeps local helpers out without dropping exported object or service APIs.

Value synthesis includes branded strings and numbers, empty sets and maps, anonymous objects with cycled literal fields, and same-typed parameters as identity replacements. Naked type-parameter returns get no fabricated values, but a same-typed parameter can still supply an identity mutant. Context-only generic types that cannot be named in the body are skipped with a reason. Literal leaves keep their type without making mutable arrays readonly. Generator mutants use the body's type before `Effect.fn` pipeables such as `Effect.scoped` or `Effect.map`.

Run it from the package whose tests you want to check. In a monorepo that resolves workspace packages through built output, build the package's dependencies first.

| Flag | Meaning |
| --- | --- |
| `--list` | print mutants, per-file counts, the total and the not-mutated count, then exit |
| `--exported-only` | only exported binding paths, curried returns and Layer service methods; exclude local helpers |
| `--in-diff <file>` | only mutants on lines a unified diff adds or changes |
| `--file <glob>`, `--exclude <glob>` | choose source files (repeatable) |
| `--jobs <n>` | scratch copies tested in parallel |
| `--timeout <s>` | per-mutant test timeout; default 5× the baseline run, at least 20 s |
| `--timeout-multiplier <x>`, `--minimum-test-timeout <s>` | tune that default |
| `--output <dir>` | results directory, default `mutants.out` |
| `--tsconfig <path>` | default `tsconfig.json` |

## Outputs

Mutant ids are stable within a version and may change between versions before 1.0. An import-adding mutant hashes its logical edit, not the retained file prefix, so edits above its binding do not change its id.

Results land in `mutants.out/`: `missed.txt`, `caught.txt`, `timeout.txt`, `unviable.txt`, `untested.txt`, `unreliable.txt`, `not-mutated.txt`, a context diff and a log per mutant, and `outcomes.json`. Every result line includes the mutant id used by `diff/<id>.diff` and `logs/<id>.log`. Lines show the declared return type when available, or an abbreviated inferred type; JSON keeps full types and uses report `schemaVersion: 2`. Add `mutants.out*` to `.gitignore`. Your source tree is never edited: each mutant runs in a scratch copy. Workspace dependency links back into the copied source tree, including package self-links, point at the scratch packages rather than the originals. Mutation imports are added when the file has no usable value import for an Effect API.

`not-mutated.txt` lists considered functions with no mutants and their reasons: unsupported return values or required fields, generic returns, and explicit exclusions. The summary includes that count. With `--in-diff`, only skips from files touched by the diff are reported. The baseline command prints before execution. A failed baseline still writes `outcomes.json`, including its command and output tail; TypeScript load errors print the tsconfig path and diagnostics.

An include glob that matches no source file is a usage error, including a path outside the package root. Diff paths resolve from the Git toplevel, with support for `git diff --relative`; outside Git they resolve from the working directory.

| Exit code | Meaning |
| --- | --- |
| 0 | no missed, unreliable, untested or timed-out mutants |
| 1 | usage, source or tsconfig error |
| 2 | some mutants were missed, or untested with no unreliable results |
| 3 | some timed out, with no missed, unreliable or untested results |
| 4 | baseline tests fail |
| 5 | the `--in-diff` diff does not match the tree |
| 6 | the diff cannot be parsed |
| 7 | some results are unreliable, with none missed |
| 70 | internal error |

Precedence is **missed (2), unreliable (7), untested (2), then timeout (3)**. A real miss wins over unreliable results; unreliable wins over an empty selection or timeout.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| caught | a test failed, or a collected test run hung on `Effect.never` past its measured budget |
| missed | the selected tests passed |
| unviable | the mutant does not type-check |
| timeout | the tests ran past the per-mutant budget without a reported failure or evidence of a caught `Effect.never` |
| untested | related selection found no test files and the full-suite fallback did not fail |
| unreliable | runner evidence is incomplete: a non-Vitest test script, an omitted importing test, or a selection probe that could not verify the package |

Vitest first runs tests related to the mutated file. When that selects no test files, mutant.cafe reruns the package's full suite within the remaining budget. A failing fallback counts as caught, including dynamic-import consumers. A passing fallback is untested, not missed: unrelated passing tests do not prove they reached the mutant.

Before the baseline, mutant.cafe checks `package.json`'s test script and asks the installed Vitest for its resolved test files. It warns when another runner owns the test script or a test importing a target is omitted. Test support imported by selected tests is not an omitted suite. Affected viable mutants are unreliable and are not scored as missed; their diagnostics name the script or omitted test. Common wrappers (`pnpm exec vitest`, `npx vitest`, `cross-env … vitest`, chained commands and `vitest --project`) count as Vitest scripts. Delegated scripts such as `turbo run test` or `pnpm -r test` are unverified, not declared non-Vitest. An unverified runner skips the baseline and records unreliable results rather than running an unsupported suite. Self-imports that resolve to built JavaScript instead of the mutated TypeScript source are also unreliable: remapping a package link cannot rebuild its output. This does not add node:test support. Literal relative imports are traced transitively; computed imports remain subject to the full-suite fallback.

Selection and partial failures come from Vitest's reporter hooks, not its human-readable messages. A reported failure still counts as caught if another test file hangs.

Ordinary mutants use the configured timeout. For `Effect.never`, mutant.cafe measures the unmutated related run once per file, including any full-suite fallback. Its budget is that duration × the timeout multiplier, with a 1 s floor. Slow tests that never call the function can finish normally; a process killed before test collection is not credited as caught. Each mutant run also sets Vitest's per-test timeout to half its budget, overriding a package's `testTimeout: 0`, and stops after the first reported failure.

## Prior art

[StrykerJS](https://stryker-mutator.io) and its Effect 4 fork [stryker-js-effect](https://github.com/systemfsoftware/stryker-js-effect) mutate syntax (operators, literals, blocks, and some Effect concurrency faults) and use the type checker to discard mutants that don't compile. mutant.cafe uses the checker to generate mutants from types instead. Use both if you like; they find different gaps.

## License

MIT
