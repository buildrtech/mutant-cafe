# @mutant-cafe/engine

Type-directed mutant discovery and in-memory viability checks. This package analyzes programs with the pinned TypeScript 6 compiler API. The workspace still checks its own code with TypeScript 7 / effect-tsrs.

## Service

Provide `MutantSourceLive` to use the core `MutantSource` service:

- `generate(config)` streams mutants from the tsconfig's source files. File include/exclude patterns match paths relative to `config.root`; function filters match names with globs. Empty include/filter lists select all candidates. Class methods use `Class.method` names.
- `checkViable(mutant)` checks an edit against the original source in the warm program that generated it. It returns syntax and semantic diagnostics for that file, without writing the edit to disk. Generate and check through the same service instance.

Each layer build owns its compiler cache. `TypeOracle` is the internal compiler boundary; `makeMutantSource(oracle)` accepts an alternate adapter. `makeTypeScriptOracle()` constructs the TS 6 adapter.

## Targets and genres

Discovery covers exported function declarations and arrow functions, class methods, `Effect.fn` generator callbacks, and `Effect.gen` bodies. Test/spec files, declaration files, dependencies, and functions with `@mutants-skip` are excluded. Effect-family detection uses checker symbols, their declarations, and type arguments, not annotation text.

The engine generates success values, tagged failures, per-tag recovery, defects and nontermination for Effect; none/some for Option; empty/one/fail for Stream; failing builds for Layer when an existing service key can be identified; and boolean, literal, primitive, array, tuple and object values. Nested Option/Effect values are synthesized recursively. Synthesis stops at depth four rather than inventing a value for an unknown required field. Tagged errors use visible constructors when their fields can be synthesized; otherwise a structural cast is marked `synthetic`.

`SwallowTag` runs the original implementation and recovers just one declared error tag. When `A` has no synthesized value, `TagToDefect` turns the tag into a defect instead. It is not labeled a swallow. Visible constructible error classes are instantiated; only unavailable constructors use a synthetic tag cast, and descriptions identify the choice.

Replacement expressions retain the original checker return type through an annotated inner function. Types outside the file use resolvable import-type references. Synthesized objects use `as const` to preserve literal fields, including recovery callbacks. Unions of Effects combine their success, error and environment types for generation. Literal choices have stable ordering, and succeeds equal to existing literal success values are omitted.

Edits replace original function bodies or generator bodies, use original-file offsets and 1-based source spans, and carry a stable SHA-256 content ID. The engine reuses existing Effect/Option/Stream/Layer namespace or named imports; it does not add imports. Generators retain the surrounding `Effect.fn` wrapper and name.

## v0 boundaries

- Viability checks the mutated file, not importers or whole-project downstream behavior.
- Programs are immutable during one service instance; create a new instance after editing input files or tsconfig.
- Wrapper APIs must already be available as value imports. Layer failures require an identifiable service key in the original body.
- Schema accept-anything and syntax/operator mutations are not implemented.
- The checker remains authoritative: a generated candidate can be unviable for advanced generic, nominal or context-sensitive types. Consumers must call `checkViable`.

## Checks

```sh
pnpm install
pnpm --filter @mutant-cafe/engine typecheck
pnpm --filter @mutant-cafe/engine exec vitest run
```

Tests execute mutated fixture code to prove each SwallowTag recovers only its own error, compile all fixture mutants, reject a deliberately invalid edit, and exercise skip tags, filters, wrapper discovery, nested values, synthetic failures and service errors. They do not snapshot generated source.
