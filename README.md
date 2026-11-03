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

Value synthesis includes branded strings and numbers, empty sets and maps, anonymous objects with cycled literal fields, and every assignable parameter as an identity replacement, named by the parameter. Boolean and literal unions with up to eight members are exhaustive, excluding an obvious original constant. Swallow mutants enumerate recoveries only for genuinely finite success types with at most four members, including both booleans. Numbers, strings, structs, Json and larger finite sets use one representative per error tag. Larger or recursive shapes have at most six synthesized representatives per function and genre, plus `undefined` when present. For `Schema.Json`, these are `null`, `""`, `0`, `false`, `[]` and `{}`. Capped tagged unions keep the original body's discriminant first, with fields emptied, then other variants in declaration order. Synthesis stops beyond depth four or 2 KiB of printed value text and records the bound. Assignable-parameter identities are separate from the literal cap. Values differing only by `as const` or redundant parentheses generate one mutant. Naked type-parameter returns get no fabricated values, but a same-typed parameter can still supply an identity mutant. Context-only generic types that cannot be named in the body are skipped with a reason. Literal leaves keep their type without making mutable arrays readonly. Generator mutants use the body's type before `Effect.fn` pipeables such as `Effect.scoped` or `Effect.map`.

Run it from the package whose tests you want to check. In a monorepo that resolves workspace packages through built output, build the package's dependencies first.

| Flag | Meaning |
| --- | --- |
| `--list` | print mutants, per-file counts, the total and the not-mutated count, then exit |
| `--exported-only` | only exported binding paths, curried returns and Layer service methods; exclude local helpers |
| `--in-diff <file>` | only mutants on lines a unified diff adds or changes |
| `--in-diff-range <A...B or A..B>` | select from `git diff` run at the repository root; exclusive with `--in-diff` |
| `--max-mutants <n>` | keep the first n selected mutants in repository path, line, column, id order |
| `--format <text or json or github>` | text by default; JSON for `--list`; Markdown for GitHub |
| `--summary-md <file>` | write the Markdown summary to a file |
| `--summary-marker <text>` | override the first-line `<!-- mutant.cafe -->` marker |
| `--advisory` | exit 0 for outcomes and baseline failure; usage and internal errors still fail |
| `--file <glob>`, `--exclude <glob>` | choose source files (repeatable) |
| `--jobs <n>` | scratch copies tested in parallel |
| `--timeout <s>` | per-mutant test timeout; default 5× the baseline run, at least 20 s |
| `--timeout-multiplier <x>`, `--minimum-test-timeout <s>` | tune that default |
| `--output <dir>` | results directory, default `mutants.out` |
| `--tsconfig <path>` | default `tsconfig.json` |

## CI

Use a git range to check changed bodies and a mutant budget to cap the work. The budget applies after file, diff and function selection. Ordering uses repository-relative file path (lexical, not locale-dependent), start line, column, then id. `--max-mutants 0` keeps none. Budget-skipped mutants are not outcomes.

This advisory GitHub Actions job writes a step summary and updates one sticky PR comment. Install mutant-cafe as a dev dependency first. Replace `npm ci` with your package manager's install command if needed; run the mutation command from the package you want to test.

```yaml
name: Mutation advisory
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  mutants:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - name: Check changed bodies
        run: >-
          npx --no-install mutant-cafe
          --in-diff-range "origin/${{ github.base_ref }}...HEAD"
          --max-mutants 40 --format github --advisory
          --summary-md mutant-summary.md
      - name: Update sticky comment
        if: github.event.pull_request.head.repo.full_name == github.repository
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('node:fs');
            const body = fs.readFileSync('mutant-summary.md', 'utf8');
            const marker = '<!-- mutant.cafe -->';
            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const comments = await github.paginate(github.rest.issues.listComments, {
              owner, repo, issue_number
            });
            const previous = comments.find(comment =>
              comment.user.type === 'Bot' && comment.body?.startsWith(marker)
            );
            if (previous) {
              await github.rest.issues.updateComment({
                owner, repo, comment_id: previous.id, body
              });
            } else {
              await github.rest.issues.createComment({ owner, repo, issue_number, body });
            }
```

Fork PRs still get the step summary; the example only posts comments on same-repository PRs. Do not switch this job to `pull_request_target` to grant untrusted PR code a write token. If a job or matrix tests multiple packages, give each summary a distinct `--summary-marker` and match that marker in the comment step.

`--format github` prints Markdown and writes the same content to `GITHUB_STEP_SUMMARY` when set. `--summary-md` also works with the default text output. The first line is `<!-- mutant.cafe -->` unless overridden. The summary counts all outcomes, lists up to 50 missed, timeout, untested and unreliable mutants with repository-root-relative paths, and says what would have failed without `--advisory`. Advisory mode does not hide bad arguments, bad refs, source errors or internal errors.

For automation without running tests, `--list --format json` prints one JSON document: `schemaVersion`, `tool`, `mutants` (the same `Mutant` shape used by report results), `notMutated`, and `counts` with `selected`, `run` and `budgetSkipped`. `selected` is the count before the budget; `run` is zero for a list and the number of recorded outcomes for an execution. The published `MutantList` and `RunReport` schemas are exported by `@mutant-cafe/core` in this workspace. Reports keep schema version 2: `selected`, `run` and `budgetSkipped` are additive optional fields, so older v2 reports still decode.

## Outputs

Mutant ids are stable within a version and may change between versions before 1.0. An import-adding mutant hashes its logical edit, not the retained file prefix, so edits above its binding do not change its id.

Results land in `mutants.out/`: `missed.txt`, `caught.txt`, `timeout.txt`, `unviable.txt`, `untested.txt`, `unreliable.txt`, `not-mutated.txt`, a context diff and a log per mutant, and `outcomes.json`. Every result line includes the mutant id used by `diff/<id>.diff` and `logs/<id>.log`. Lines show the declared return type when available, or an abbreviated inferred type; JSON keeps full types and uses report `schemaVersion: 2`. Add `mutants.out*` to `.gitignore`. Your source tree is never edited: each mutant runs in a scratch copy. Workspace dependency links back into the copied source tree, including package self-links, point at the scratch packages rather than the originals. Mutation imports are added when the file has no usable value import for an Effect API.

`not-mutated.txt` gives one located line per considered function or Layer value with omitted mutations: `file:line:column`, target path and reason. Layer values use their initializer location; unavailable locations print `?:?`. It reports unsupported return fields, generic returns, explicit exclusions, capped values with an omitted count, and error classes whose constructors are unavailable. A constructor failure does not suppress recoveries or defects. Callbacks in arguments and arrays have their own locations; schema and brand constants are not functions. When a return cannot be synthesized but inner functions are mutated, the reason says so. The summary includes the line count. A target that the compiler cannot analyse gets a located `analysis failed` reason without aborting the remaining targets. Faults discovered during viability checks join the same skip report rather than becoming unviable outcomes. Config and program-load failures still stop the run. With `--in-diff`, only skips from files touched by the diff are reported. An empty selection, including a zero budget or a diff outside function bodies, skips the baseline, prints the selection count and cause to stderr, and writes a report with zero run and no baseline command. An empty actionable summary says “No actionable mutants.” The baseline command prints before execution when there are selected mutants. A failed baseline still writes `outcomes.json`, including its command and output tail; TypeScript load errors print the tsconfig path and diagnostics.

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
| unreliable | an unsupported runner, an omitted importing test, or a selected test reading a built self-entry instead of the affected source |

Vitest first runs tests related to the mutated file. When that selects no test files, mutant.cafe reruns the package's full suite within the remaining budget. A failing fallback counts as caught, including dynamic-import consumers. A passing fallback is untested, not missed: unrelated passing tests do not prove they reached the mutant.

Before the baseline, mutant.cafe checks `package.json`'s test script and asks the installed Vitest for its resolved test files. It warns when another runner owns the test script or a test importing a target is omitted. Test support imported by selected tests is not an omitted suite. Affected viable mutants are unreliable and are not scored as missed; their diagnostics name the script or omitted test. Common wrappers (`pnpm exec vitest`, `npx vitest`, `cross-env … vitest`, chained commands and `vitest --project`) count as Vitest scripts. Delegated scripts such as `turbo run test` or `pnpm -r test` are unverified, not declared non-Vitest.

Only an explicit non-Vitest runner skips the baseline and makes all results unreliable. Delegated or unknown scripts and failed selection probes warn but do not disable the Vitest baseline.

Self-imports that resolve to built JavaScript are scoped: the export's `types` condition or explicit tsconfig `rootDir`/`outDir` maps the entry back to source and its import closure. A mutant in that closure is unreliable only if its actual selected tests include a test that imports the built entry. If mapping is unavailable, only that selected-test condition applies. Selection comes from the running Vitest reporter, including a full-suite fallback. Other mutants run normally; a built self-import never disables the baseline. Remapping a package link cannot rebuild its output.

This does not add `node:test` support. Literal relative imports are traced transitively; computed imports remain subject to the full-suite fallback.

Selection and partial failures come from Vitest's reporter hooks, not its human-readable messages. A reported failure still counts as caught if another test file hangs.

### Warm and cold runs

By default, each scratch copy keeps one warm instance of the project's installed Vitest. Mutations and restores invalidate the changed module and its importers before the next run. Vitest's normal per-file isolation resets module-level state. `--jobs N` uses N scratch copies and N instances.

Use `--cold` to start a fresh Vitest process for every mutant. Projects with `isolate: false`, `poolOptions.*.isolate: false`, or `--no-isolate` use cold mode with a warning. An unsupported Vitest Node API also falls back to cold mode. The warm adapter is tested against Vitest 5.1.0.

A run that exceeds its deadline requests cancellation. If it does not settle within 500 ms, mutant.cafe closes the instance and starts another. A crashed pool gets one restart for that mutant. A second crash switches the remaining run to cold mode with a warning.

Ordinary mutants use the configured timeout. For `Effect.never`, the reporter measures the slowest passing test in the original related files, including any full-suite fallback. The per-test timeout is that duration × the timeout multiplier, with a 2 s floor, rather than the duration of the whole suite. Explicit per-test timeout options remain in effect, including larger values. Vitest does not expose a configuration API to raise a smaller explicit per-test timeout; those tests still use their own value. Reports record the computed timeout on each mutant result. The outer deadline also allows the baseline run's duration for startup, collection and hooks. A process killed before test collection is not credited as caught. Other mutants keep the existing per-test timeout of half their run budget. Both modes stop after the first reported failure.

## Prior art

[StrykerJS](https://stryker-mutator.io) and its Effect 4 fork [stryker-js-effect](https://github.com/systemfsoftware/stryker-js-effect) mutate syntax (operators, literals, blocks, and some Effect concurrency faults) and use the type checker to discard mutants that don't compile. mutant.cafe uses the checker to generate mutants from types instead. Use both if you like; they find different gaps.

## License

MIT
