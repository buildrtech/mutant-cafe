# @mutant-cafe/runner

Runs mutation tests in disposable copies. The caller supplies `MutantSource` and
`Reporter`; this package supplies `ScratchLive`, `TestRunnerLive` and `runMutants`.

```ts
import { ScratchLive, TestRunnerLive, runMutants } from "@mutant-cafe/runner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const runner = Layer.mergeAll(ScratchLive, TestRunnerLive).pipe(
  Layer.provide(NodeServices.layer)
);

// Provide MutantSource and Reporter at the application boundary.
const program = runMutants(config).pipe(Effect.provide(runner));
```

`runMutants(config, mutants?)` accepts an optional stream instead of calling
`MutantSource.generate`. It still calls `MutantSource.checkViable` for each mutant.
It returns a `RunReport`, or a core `BaselineFailed`, `ScratchError`,
`TestSpawnError`, `ProgramLoadError` or `ReportWriteError`.

## Lifecycle

```text
copying → baseline → generating → testing → reporting → done
             └─ baselineFailed
cancel from any active state → interrupted → partial report → done
```

- A failing baseline stops before generating or testing mutants.
- The scratch pool has `jobs` isolated directories, with at least one worker.
  Each worker restores the exact original file bytes before returning its lease.
- Tests run through the package's Vitest using `npx --no vitest`. Baseline uses
  `run`; mutants start with `related <file> --run --passWithNoTests`. If no test
  files are selected, run the full package suite within the remaining budget.
  If that also selects no files, report `untested`. A scoped reporter uses Vitest's
  collection and result hooks to distinguish empty selection, reported failures
  and pre-collection kills. A reported failure survives an outer timeout.
- Result and transform caches are disabled because dependency directories are
  symlinked to the source checkout. Tests must not write through dependency links.
- A mutant timeout is `timeoutMs`, or the greater of `minimumTimeoutMs` and
  `ceil(timeoutMultiplier × baseline.durationMs)`. `EffectNever` uses
  the greater of `neverTimeoutMs` (a floor) and the unmutated related-run duration
  × the multiplier. Measure that selection once per file before applying mutants.
  A killed `EffectNever` is caught only after collection, not during module loading.
  Mutant runs override Vitest's per-test timeout with half their budget and pass
  `--bail 1`. The scoped Node spawner terminates the process group on timeout or cancellation.
- Scratch discovers an enclosing pnpm workspace or Git root and copies it so
  package-relative tsconfig references still work. Vitest runs in the requested
  package directory. Dependency directories are symlinked; Git, output and
  local agent metadata are excluded. Other source symlinks are materialized.
- Mutant file names may be package-relative or absolute paths in the source
  package. Escaping paths and mutations inside `node_modules` are rejected.

Interrupt the returned Effect to cancel a run. Completed results are written
before scratch resources are released; the caller still receives interruption.
An interruption before baseline completion produces a partial report with a
zero-duration baseline and an empty baseline command. The current core report
schema has no separate incomplete-run field. Generation and testing failures
also attempt to write their completed results before returning the error.

## Checks

```sh
pnpm --filter @mutant-cafe/runner typecheck
pnpm --filter @mutant-cafe/runner exec vitest run
```

The tests run real Vitest against `fixtures/tagged-errors`, with handwritten
mutants. They cover caught, missed, unviable and timeout outcomes; unchanged
fixture bytes; scratch reuse and concurrent isolation; baseline failure;
interruption reporting; and disappearance of the timed-out test process.
