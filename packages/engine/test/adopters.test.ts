import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type RunConfig } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { makeMutantSource, makeTypeScriptOracle } from "../src/index.ts";

// Compiler-only proofs: never import or execute a replacement.
const project = (text: string, options = {}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "adopter-analysis-", directory: import.meta.dirname });
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module"}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: {
    strict: true, target: "ESNext", module: "NodeNext", skipLibCheck: true, noEmit: true, ...options,
  }, include: ["input.ts"] }));
  yield* fs.writeFileString(`${root}/input.ts`, text);
  const config: RunConfig = { root, tsconfig: "tsconfig.json", include: [], exclude: [], functionFilter: [], jobs: 1,
    timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out" };
  const source = makeMutantSource(makeTypeScriptOracle());
  const mutants = yield* Stream.runCollect(source.generate(config));
  return { root, source, mutants };
});

for (const explicitBuildInfo of [false, true]) it.live(`loads incremental noEmit projects without writing a build-info file (${explicitBuildInfo ? "explicit path" : "default path"})`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root, source, mutants } = yield* project('export const answer = (n: number): boolean => n > 0;', { incremental: true, ...(explicitBuildInfo ? { tsBuildInfoFile: "analysis.tsbuildinfo" } : {}) });
  expect(mutants.map(m => m.description)).toContain("replace answer -> boolean with false");
  expect(mutants.map(m => m.description)).toContain("replace answer -> boolean with true");
  for (const mutant of mutants) expect((yield* source.checkViable(mutant)).viable).toBe(true);
  expect((yield* fs.readDirectory(root)).filter(file => /tsbuildinfo|\.js$/.test(file))).toEqual([]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("omits direct pure literals through parentheses and type-only wrappers, not effectful expressions with literal return types", () => Effect.gen(function* () {
  const { mutants } = yield* project(`
    let calls = 0;
    const tick = (): false => { calls++; return false; };
    export const defaultValue = () => false;
    export const broad = (): boolean => (false as boolean);
    export const asserted = (): true => (false as true);
    export const emptyArray = (): number[] => (([] satisfies number[]));
    export const emptyObject = (): object => (({} as object)!);
    export const singleReturn = (): number[] => { return ([] as number[]); };
    export const call = (): boolean => tick();
    export const statements = (): boolean => { calls++; return false; };
    export const nested = (): boolean => { const unused = () => false; calls++; return false; };
    export const emptyBody = (): void => { /* no observable work */ };
    export const effectfulVoid = (): void => { calls++; };
  `);
  const descriptions = (name: string) => mutants.filter(m => m.functionName === name).map(m => m.description);
  for (const name of ["defaultValue", "broad"]) {
    expect(descriptions(name).some(text => text.endsWith(" with false"))).toBe(false);
    expect(descriptions(name).some(text => text.endsWith(" with true"))).toBe(true);
  }
  for (const name of ["emptyArray", "singleReturn"]) {
    expect(descriptions(name).some(text => text.endsWith(" with []")), name).toBe(false);
    expect(descriptions(name).some(text => text.endsWith(" with [0]")), name).toBe(true);
  }
  expect(descriptions("emptyObject").some(text => text.endsWith(" with {}"))).toBe(false);
  expect(descriptions("asserted").some(text => text.endsWith(" with true"))).toBe(true);
  expect(descriptions("emptyBody")).toEqual([]);
  expect(descriptions("effectfulVoid")).toEqual(["replace effectfulVoid -> void with an empty body"]);
  for (const name of ["call", "statements", "nested"]) {
    expect(descriptions(name).some(text => text.endsWith(" with false")), name).toBe(true);
    expect(descriptions(name).some(text => text.endsWith(" with true")), name).toBe(true);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("recognizes Effect void and succeed imports and const aliases without hiding observable work", () => Effect.gen(function* () {
  const { mutants } = yield* project(`
    import { Effect as E } from "effect";
    import * as Fx from "effect/Effect";
    import { succeed as ok, void as unit } from "effect/Effect";
    const pure = ok;
    const alias = unit;
    let calls = 0;
    export const voidValue = (): E.Effect<void> => E.void;
    export const namespaceVoid = (): E.Effect<void> => Fx.void;
    export const importedVoid = (): E.Effect<void> => unit;
    export const aliasedVoid = (): E.Effect<void> => alias;
    export const aliasSucceed = (): E.Effect<void> => pure(undefined);
    export const directSucceed = (): E.Effect<void> => E.succeed(undefined);
    export const literalSucceed = (): E.Effect<number[]> => ok(([] as number[]));
    export const statements = (): E.Effect<void> => { calls++; return ok(undefined); };
    export const tapped = (): E.Effect<void> => ok(undefined).pipe(E.tap(() => E.sync(() => { calls++; })));
    export const nested = (): E.Effect<void> => E.suspend(() => { calls++; return ok(undefined); });
    const same = (): undefined => { calls++; return undefined; };
    export const argument = (): E.Effect<void> => ok(same());
    const getEffect = () => { calls++; return E; };
    export const receiver = (): E.Effect<void> => getEffect().void;
    export const calledReceiver = (): E.Effect<void> => getEffect().succeed(undefined);
    const namespace = E;
    export const namespaceAlias = (): E.Effect<void> => namespace.void;
    export const pureGenerator = E.fn(function* (): E.fn.Return<number[]> { return ([] as number[]); });
    export const effectfulGenerator = E.fn(function* (): E.fn.Return<number[]> { calls++; return []; });
  `);
  for (const name of ["voidValue", "namespaceVoid", "importedVoid", "aliasedVoid", "aliasSucceed", "directSucceed", "namespaceAlias"]) {
    expect(mutants.filter(m => m.functionName === name && m.genre === "EffectSucceed"), name).toEqual([]);
    expect(mutants.some(m => m.functionName === name && m.genre === "EffectDie"), name).toBe(true);
  }
  expect(mutants.some(m => m.functionName === "pureGenerator" && m.description.endsWith("succeed([])"))).toBe(false);
  expect(mutants.some(m => m.functionName === "effectfulGenerator" && m.description.endsWith("succeed([])"))).toBe(true);
  expect(mutants.some(m => m.functionName === "literalSucceed" && m.description.endsWith("succeed([])"))).toBe(false);
  expect(mutants.some(m => m.functionName === "literalSucceed" && m.description.endsWith("succeed([0])"))).toBe(true);
  for (const name of ["statements", "tapped", "nested", "argument", "receiver", "calledReceiver"]) expect(mutants.some(m => m.functionName === name && m.genre === "EffectSucceed"), name).toBe(true);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
