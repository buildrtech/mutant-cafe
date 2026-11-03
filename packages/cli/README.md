# @mutant-cafe/cli

Private CLI and reporting adapter. Nothing in this package is published to npm.
`mutant-cafe` is a placeholder bin name.

## Integration boundary

This is a library packet. The executable deliberately prints a diagnostic and
sets exit code 70 until the integration layer wires the live services. It does
not silently run a fake engine or fake tests.

`runCli({ root, args, run })` parses an argument array (without the node/script
prefix), returns the CI exit code, and requires the platform's filesystem, path,
terminal, process and stdio services plus the core services. The integration
entrypoint provides the Node platform layer, `MutantSource`, `Scratch` and
`TestRunner`, passes the runner's `runMutants` as `run`, and sets the process exit
code to the returned number. `makeCommand({ root, run, onExit })` exposes the
Effect CLI command independently.

The injected `run(config, selectedMutants)` returns an Effect of `RunReport`,
with `BaselineFailed | ScratchError | TestSpawnError | ProgramLoadError` errors
and only core service requirements. It calls `Reporter.progress` for results;
the CLI owns `Reporter.write` after the run returns. The command enumerates and
filters mutants before calling the runner, so `mutants.json` and mutant patches
exist before baseline/tests start. List mode never calls the runner or rotates
reports.

## Flags and configuration

The command operates on `root` (normally the current working directory):

| Flag | Meaning / default |
| --- | --- |
| `--list` | Print selected mutants without testing or writing reports |
| `--in-diff <file>` | Select spans intersecting added lines; validate the diff's new side against the tree |
| `--file <glob>` | Include glob, repeatable; default `**/*.{ts,tsx}` |
| `--exclude <glob>` | Exclude glob, repeatable |
| `--jobs <integer>` | Positive worker count, default 1 |
| `--timeout <seconds>` | Positive absolute timeout, converted to milliseconds |
| `--timeout-multiplier <number>` | Positive baseline multiplier, default 5 |
| `--minimum-test-timeout <seconds>` | Positive minimum timeout, default 20 seconds |
| `--output <directory>` | Default `mutants.out`; relative to root or absolute |
| `--tsconfig <file>` | Default `tsconfig.json` |

Optional `mutants.config.json` is decoded with core `ConfigFile`. Supplied flags
win. Array flags replace, rather than append to, the corresponding config array.
`functionFilter` is read from the config file; `minimumTimeoutMs` there is in
milliseconds. The internal `neverTimeoutMs` floor is 1000 ms; the actual budget
uses the measured unmutated related-run duration × the multiplier. Include globs
that match no source files exit 1 and name each unmatched glob.

Text unified diffs (including git headers, multiple files/hunks, additions,
deletions and missing final newlines) are checked for consistent hunk counts and
new-side text. Deleted files select no mutants. Empty diffs select nothing.
Binary patches are not supported. Paths resolve from the Git toplevel, with a
cwd-relative fallback for `--relative` diffs and outside Git. Paths escaping the
repository root are rejected.

## Report lifecycle

`makeReporter({ root, outDir, mutants })` prepares an implementation of the core
`Reporter`; `ReporterLive(options)` is the corresponding Effect layer.

- Rotate existing output to `<outDir>.old`, removing an older report backup.
  Existing output/backup directories must contain `mutants.json`, so unrelated
  directories are not erased. The project root and its ancestors cannot be
  output directories.
- Schema-encode all selected mutants to `mutants.json` before execution.
- Write valid unified patches to `diff/<id>.diff` against the original source.
  Mutant IDs must be unique safe filenames.
- Write `logs/<id>.log` and the five outcome lists, including `untested.txt`, as
  results arrive. Lines are `file:line:col: description [id]`. Declared return types
  are preferred; inferred display types are capped at 80 characters. JSON retains
  full types. Progress writes are serialized. List mode ends with per-file counts
  and a total.
- Print each result as it arrives. If a progress write fails, warn once and
  retain the typed error for `Reporter.write`; the core progress contract has
  no error channel.
- At completion, Schema-encode core `RunReport` to a temporary file and rename
  it to `outcomes.json`, reconcile lists/logs with the final report, and print
  outcome counts plus wall time.

`outcomes.json` is a final whole document, not a fabricated partial report:
`Reporter.progress` does not receive baseline/timeout metadata. Outcome text
lists are the incremental surface. Logs contain diagnostics, plus raw test
output when a result has an optional `output: string` field. The current core
contract does not yet declare that field; the integration layer can add it
without changing this adapter. Raw baseline output is not available on the
successful core `Baseline` contract.

## CI exits

0: no missed, untested or timed-out mutants (or list mode); 1: usage/config; 2: missed or untested;
3: timeout with no missed or untested mutants; 4: baseline failed; 5: new-side diff/tree
mismatch; 6: invalid/unreadable diff; 70: internal/report/platform errors.
A missed or untested mutant takes precedence over a timeout in the same report.

Cargo-mutants is the inspiration for the exit table and output layout:
[exit codes](https://mutants.rs/exit-codes.html),
[output directory](https://mutants.rs/mutants-out.html).

## Checks

```sh
pnpm --filter @mutant-cafe/cli typecheck
pnpm --filter @mutant-cafe/cli exec vitest run
```

Tests use temporary real files, a real git diff of the tagged-errors fixture,
and `git apply` on a generated mutant patch. They cover selection/tree mismatch,
malformed diff rejection, report rotation, incremental writes, failed writes,
config precedence and CI outcomes. No console snapshots or Schema-library tests.
