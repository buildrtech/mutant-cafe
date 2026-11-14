import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type RunConfig } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { makeMutantSource, makeTypeScriptOracle } from "../src/index.ts";

// Compiler-only proofs: never import or execute a replacement.
const project = (text: string, options = {}, files: Readonly<Record<string, string>> = {}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "adopter-analysis-", directory: import.meta.dirname });
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module"}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: {
    strict: true, target: "ESNext", module: "NodeNext", skipLibCheck: true, noEmit: true, ...options,
  }, include: ["input.ts"] }));
  yield* fs.writeFileString(`${root}/input.ts`, text);
  for (const [file, content] of Object.entries(files)) {
    const slash = file.lastIndexOf("/");
    if (slash >= 0) yield* fs.makeDirectory(`${root}/${file.slice(0, slash)}`, { recursive: true });
    yield* fs.writeFileString(`${root}/${file}`, content);
  }
  const config: RunConfig = { root, tsconfig: "tsconfig.json", include: [], exclude: [], functionFilter: [], jobs: 1,
    timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out" };
  const source = makeMutantSource(makeTypeScriptOracle());
  const mutants = yield* Stream.runCollect(source.generate(config));
  return { root, source, mutants, config };
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
    const FLAG = false;
    export const flag = (): boolean => FLAG;
    const ALIAS = FLAG;
    export const aliasFlag = (): boolean => ALIAS;
    const holder: { readonly value: false } = { get value() { calls++; return false; } };
    export const propertyFlag = (): boolean => holder.value;
    export const elementFlag = (): boolean => holder["value"];
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
  for (const name of ["defaultValue", "broad", "flag", "aliasFlag"]) {
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
  for (const name of ["call", "statements", "nested", "propertyFlag", "elementFlag"]) {
    expect(descriptions(name).some(text => text.endsWith(" with false")), name).toBe(true);
    expect(descriptions(name).some(text => text.endsWith(" with true")), name).toBe(true);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("retains unconditional success across a failing branch and inner callbacks that perform work", () => Effect.gen(function* () {
  const { source, mutants, config } = yield* project(`
    import { Data, Effect } from "effect";
    interface Status { readonly state: "on" | "off" }
    class Missing extends Data.TaggedError("Missing") {}
    export const read = (ok: boolean): Effect.Effect<Status, Missing> => ok ? Effect.succeed({ state: "on" }) : Effect.fail(new Missing());
    export const opaque = (): { call: () => void } => ({ call: () => {} });
    export const opaqueWithWork = (work: () => void): { call: () => void } => ({ call: () => { work(); } });
    export const opaqueWithMember = (x: { call: () => void }): { call: () => void } => ({ call: () => { x.call(); } });
  `);
  const successes = mutants.filter(mutant => mutant.functionName === "read" && mutant.genre === "EffectSucceed");
  expect(successes.length).toBeGreaterThan(0);
  for (const mutant of successes) expect((yield* source.checkViable(mutant)).viable).toBe(true);
  expect(mutants.filter(mutant => mutant.functionName === "opaque.call")).toEqual([]);
  const callbacks = mutants.filter(mutant => mutant.functionName === "opaqueWithWork.call");
  expect(callbacks).toHaveLength(1);
  expect(callbacks[0]?.replacement.text).toBe("{}");
  expect((yield* source.checkViable(callbacks[0]!)).viable).toBe(true);
  expect(mutants.filter(mutant => mutant.functionName === "opaqueWithMember.call")).toHaveLength(1);
  const skipped = yield* source.notMutated(config);
  expect(skipped.find(item => item.functionName === "opaqueWithWork")?.reason).toContain("inner functions mutated");
  expect(skipped.find(item => item.functionName === "opaque")?.reason).not.toContain("inner functions mutated");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("does not mistake a local effect/Effect wrapper for the installed Effect constructors", () => Effect.gen(function* () {
  const { mutants } = yield* project(`
    import * as Wrapper from "./effect/Effect.js";
    export const wrappedSuccess = () => Wrapper.succeed(undefined);
    export const wrappedVoid = () => Wrapper.void;
  `, {}, { "effect/Effect.ts": `
    import * as Effect from "effect/Effect";
    export const succeed = (_: undefined) => { console.log("observed construction"); return Effect.succeed(undefined); };
    const void_ = Effect.sync(() => { console.log("observed execution"); });
    export { void_ as void };
  ` });
  for (const name of ["wrappedSuccess", "wrappedVoid"]) expect(mutants.some(mutant => mutant.functionName === name && mutant.genre === "EffectSucceed"), name).toBe(true);
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
    const FLAG = false;
    export const constGenerator = E.fn(function* (): E.fn.Return<boolean> { return FLAG; });
    export const observedGenerator = E.fn(function* (): E.fn.Return<boolean> { calls++; return FLAG; });
  `);
  for (const name of ["voidValue", "namespaceVoid", "importedVoid", "aliasedVoid", "aliasSucceed", "directSucceed", "namespaceAlias"]) {
    expect(mutants.filter(m => m.functionName === name && m.genre === "EffectSucceed"), name).toEqual([]);
    expect(mutants.some(m => m.functionName === name && m.genre === "EffectDie"), name).toBe(true);
  }
  expect(mutants.some(m => m.functionName === "constGenerator" && m.description.endsWith("succeed(false)"))).toBe(false);
  expect(mutants.some(m => m.functionName === "constGenerator" && m.description.endsWith("succeed(true)"))).toBe(true);
  expect(mutants.some(m => m.functionName === "observedGenerator" && m.description.endsWith("succeed(false)"))).toBe(true);
  expect(mutants.some(m => m.functionName === "pureGenerator" && m.description.endsWith("succeed([])"))).toBe(false);
  expect(mutants.some(m => m.functionName === "effectfulGenerator" && m.description.endsWith("succeed([])"))).toBe(true);
  expect(mutants.some(m => m.functionName === "literalSucceed" && m.description.endsWith("succeed([])"))).toBe(false);
  expect(mutants.some(m => m.functionName === "literalSucceed" && m.description.endsWith("succeed([0])"))).toBe(true);
  for (const name of ["statements", "tapped", "nested", "argument", "receiver", "calledReceiver"]) expect(mutants.some(m => m.functionName === name && m.genre === "EffectSucceed"), name).toBe(true);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
