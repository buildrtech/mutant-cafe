// Integration tests exercise the real compiler and runtime filesystem boundaries.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { MutantSource, type Mutant, type RunConfig } from "@mutant-cafe/core";
import { makeMutantSource, makeTypeScriptOracle, MutantSourceLive } from "../src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const config = (tsconfig: string, overrides: Partial<RunConfig> = {}): RunConfig => ({
  root, tsconfig, include: [], exclude: [], functionFilter: [], jobs: 1,
  timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100,
  outDir: "mutants.out", ...overrides,
});
const fixture = config("fixtures/tagged-errors/tsconfig.json");
const extra = config("packages/engine/test/fixtures/tsconfig.json");
const collect = (source: MutantSource["Service"], input: RunConfig) => Stream.runCollect(source.generate(input));
const makeSource = () => makeMutantSource(makeTypeScriptOracle());

// Runtime entry point is known from the real fixture and exercised by both error scenarios.
interface AccountModule {
  readonly withdraw: (account: { id: string; balance: number; frozen: boolean }, amount: number) => Effect.Effect<unknown, { readonly _tag: string }>;
}
function loadMutation<A = AccountModule>(mutant: Mutant) {
  return Effect.gen(function* () {
    const original = yield* Effect.promise(() => readFile(mutant.file, "utf8"));
    const edit = mutant.replacement;
    const text = original.slice(0, edit.startOffset) + edit.text + original.slice(edit.endOffset);
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(resolve(root, "packages/engine/test/runtime-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const file = resolve(directory, "account.mjs");
    yield* Effect.promise(() => writeFile(file, ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText));
    // SAFETY: each caller supplies the contract declared by its real fixture and exercises it.
    return yield* Effect.promise((): Promise<A> => import(pathToFileURL(file).href));
  });
}

describe("checker-directed mutation", () => {
  it.effect("gives every generated mutant a distinct description within its function", () => Effect.gen(function* () {
    const source = makeSource();
    for (const input of [fixture, extra]) {
      const mutants = yield* collect(source, input);
      expect(mutants.length).toBeGreaterThan(0);
      const functions = new Map<string, Set<string>>();
      for (const mutant of mutants) {
        const key = JSON.stringify([mutant.file, mutant.functionName, mutant.span]);
        const descriptions = functions.get(key) ?? new Set<string>();
        expect(descriptions.has(mutant.description), mutant.description).toBe(false);
        descriptions.add(mutant.description);
        functions.set(key, descriptions);
      }
    }
  }));

  it.effect("swallows precisely the two declared errors while preserving the other path", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, fixture);
    const swallows = mutants.filter((m) => m.functionName === "withdraw" && m.genre === "SwallowTag");
    expect(swallows).toHaveLength(2);
    const recovered: string[] = [];
    for (const mutant of swallows) {
      const module = yield* loadMutation(mutant);
      const frozen = yield* Effect.exit(module.withdraw({ id: "a", balance: 10, frozen: true }, 1));
      const overdrawn = yield* Effect.exit(module.withdraw({ id: "a", balance: 10, frozen: false }, 11));
      expect([Exit.isSuccess(frozen), Exit.isSuccess(overdrawn)].filter(Boolean)).toHaveLength(1);
      recovered.push(Exit.isSuccess(frozen) ? "Frozen" : "Overdrawn");
    }
    expect(recovered.sort()).toEqual(["Frozen", "Overdrawn"]);
  }));

  it.effect("type-checks every real fixture mutant and rejects an ill-typed edit without poisoning the next check", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, fixture);
    expect(mutants.length).toBeGreaterThan(8);
    for (const mutant of mutants) {
      const viability = yield* source.checkViable(mutant);
      expect(viability.diagnostics, mutant.description).toEqual([]);
      expect(viability.viable).toBe(true);
    }
    const boolean = mutants.find((m) => m.functionName === "isEmpty")!;
    const bad = { ...boolean, replacement: { ...boolean.replacement, text: '{ return "not a boolean"; }' } };
    const failure = yield* source.checkViable(bad);
    expect(failure.viable).toBe(false);
    expect(failure.diagnostics.some((d) => d.includes("TS2322"))).toBe(true);
    expect((yield* source.checkViable(boolean)).viable).toBe(true);
  }), 30_000);

  it.effect("discovers wrappers, methods, and non-Effect genres, skips JSDoc tags, and checks their viability", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, extra);
    const names = new Set(mutants.map((m) => m.functionName));
    expect(names.has("skipped")).toBe(false);
    expect(names.has("skippedArrow")).toBe(false);
    expect(names.has("privateFunction")).toBe(false);
    expect(names.has("mapped")).toBe(false);
    for (const name of ["bool", "literal", "numeric", "words", "array", "nothing", "option", "stream", "layer", "generated", "named", "program", "maybe", "nested", "synthetic", "Counter.value"]) expect(names.has(name), name).toBe(true);
    expect(mutants.some((m) => m.functionName === "synthetic" && m.genre === "EffectFail" && m.synthetic)).toBe(true);
    expect(mutants.some((m) => m.functionName === "nested" && m.genre === "EffectSucceed")).toBe(true);
    expect(mutants.some((m) => m.functionName === "maybe" && m.genre === "OptionSome")).toBe(true);
    const genres = new Set(mutants.map((m) => m.genre));
    for (const genre of ["OptionNone", "OptionSome", "StreamEmpty", "StreamOne", "StreamFail", "LayerFail", "LiteralCycle", "FnValue"]) expect(genres.has(genre as Mutant["genre"]), genre).toBe(true);
    for (const mutant of mutants) expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
  }), 30_000);

  it.effect("uses a defect to swallow an error when no success value exists", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, extra);
    const swallow = mutants.find((m) => m.functionName === "program" && m.genre === "SwallowTag");
    expect(swallow).toBeDefined();
    if (!swallow) return;
    expect(swallow.synthetic).toBe(false);
    expect((yield* source.checkViable(swallow)).viable).toBe(true);
    const module = yield* loadMutation<{ readonly program: Effect.Effect<never, { readonly _tag: "Missing" }> }>(swallow);
    const exit = yield* Effect.exit(module.program);
    expect(Exit.hasDies(exit)).toBe(true);
    expect(Exit.hasFails(exit)).toBe(false);
  }));

  it.effect("honors file and function filters and produces stable content ids", () => Effect.gen(function* () {
    const source = makeSource();
    const input = config(fixture.tsconfig, { include: ["**/account.ts"], functionFilter: ["isEmpty"] });
    const first = yield* collect(source, input);
    expect(first).toHaveLength(2);
    expect(first.every((m) => m.functionName === "isEmpty")).toBe(true);
    expect((yield* collect(source, input)).map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(yield* collect(source, { ...input, exclude: ["**/account.ts"] })).toEqual([]);
  }));

  it.effect("exposes the service layer and reports unreadable tsconfigs in the typed channel", () => Effect.gen(function* () {
    const source = yield* MutantSource;
    const result = yield* collect(source, config("missing-tsconfig.json")).pipe(Effect.flip);
    expect(result._tag).toBe("ProgramLoadError");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(MutantSourceLive)));
});
