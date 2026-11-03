import { Brand, Context, Data, Effect, Layer, Schema } from "effect";

export class NumberService extends Context.Service<NumberService, { readonly n: number }>()("coverage/Number") {}
export const live = Layer.effect(NumberService, Effect.succeed({ n: 1 }));
export const idle = Layer.effect(NumberService, Effect.succeed({ n: 2 }));
export const weakLayer = Layer.succeed(NumberService, { n: 3 });
export const layerFunction = () => Layer.effect(NumberService, Effect.succeed({ n: 1 }));
export const idleLayerFunction = () => Layer.effect(NumberService, Effect.succeed({ n: 2 }));
export class StaticService extends Context.Service<StaticService, { readonly n: number }>()("coverage/Static") {
  static readonly layer = Layer.effect(this, Effect.succeed({ n: 1 }));
  static readonly idle = Layer.effect(this, Effect.succeed({ n: 2 }));
}

class BadInput extends Data.TaggedError("BadInput") {}
function internal(n: number): number { return n + 1; }
function weakInternal(n: number): number { return n + 1; }
export const weakInternalUse = (n: number) => weakInternal(n);
const internalEffect = Effect.fn("internalEffect")(function* (n: number) {
  if (n < 0) return yield* new BadInput();
  return n;
});
const untraced = Effect.fnUntraced(function* (n: number) {
  if (n < 0) return yield* new BadInput();
  return n;
});
export const useInternal = (n: number) => internal(n);
export const useEffect = (n: number) => internalEffect(n);
export const useUntraced = (n: number) => untraced(n);

export class Greeter extends Context.Service<Greeter, {
  readonly greet: (n: number) => Effect.Effect<number, BadInput>;
  readonly send: (n: number) => Effect.Effect<number>;
  readonly loose: (n: number) => Effect.Effect<number>;
}>()("coverage/Greeter") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const greet = Effect.fn("greet")(function* (n: number) {
      if (n < 0) return yield* new BadInput();
      return n;
    });
    return Greeter.of({ greet: greet, send: (n: number) => Effect.succeed(n), loose: (n: number) => Effect.succeed(n + 1) });
  }));
}
export const weakPolicy = { allowed: (n: number): boolean => n > 0 };
export const weakGuardFor = (prefix: string) => (url: string): "send" | "drop" => url.startsWith(prefix) ? "send" : "drop";
export const policy = { canEdit: (n: number): boolean => n > 0 };
const machine = { guards: { allowed: (n: number): boolean => n > 0 } };
export const allowed = (n: number) => machine.guards.allowed(n);
export const guardFor = (prefix: string) => (url: string): "send" | "drop" => url.startsWith(prefix) ? "send" : "drop";

export type Id = string & Brand.Brand<"Id">;
export const brand = (text: string): Id => text as Id;
export const set = (): ReadonlySet<string> => new Set(["a"]);
export const idleSet = (): ReadonlySet<string> => new Set(["b"]);
export const map = (): ReadonlyMap<string, number> => new Map([["a", 1]]);
export const idleMap = (): ReadonlyMap<string, number> => new Map([["b", 2]]);
export const object = (n: number): { state: "on" | "off"; n: number } => ({ state: n ? "on" : "off", n });
export const identityCandidate = (n: number, extra: number): number => n + extra;
export const identityGeneric = <T>(value: T, other: T, first: boolean): T => first ? value : other;
export const weakBrand = (text: string): Id => text as Id;
export const weakSet = (): ReadonlySet<string> => new Set(["a"]);
export const weakMap = (): ReadonlyMap<string, number> => new Map([["a", 1]]);
export const weakObject = (n: number): { state: "on" | "off"; n: number } => ({ state: n ? "on" : "off", n });
export const weakIdentity = (n: number, extra: number): number => n + extra;

export const helperOwner = (n: number): number => {
  function localDeclaration(x: number): number { return x + 1; }
  const localArrow = (x: number): number => x + 1;
  return localDeclaration(n) + localArrow(n);
};
export const parenthesized = (a: number) => ((b: number): boolean => a > b);
export const blocked = (a: number) => { return (b: number): boolean => a > b; };
export const curriedEffect = (a: number) => Effect.fn(function* (b: number) { return a + b; });
export const callbacks = [(n: number): number => n + 1];
export const argument = [1].map((n: number): number => n + 1);

export const generic = <T>(): T => { throw new Error("no generic value"); };
export const genericElement = <const T extends readonly unknown[]>(xs: T): T[number] => xs[0];
interface Reader { readonly get: <A>(fallback: A) => Effect.Effect<A> }
export const reader: Reader = { get: fallback => Effect.succeed(fallback) };
export const opaque = (): { call: () => void } => ({ call: () => {} });

interface Finding { readonly key: string }
export const report = Effect.fn("report")(function* (xs: readonly string[]) {
  const ok = yield* Schema.decodeEffect(Schema.Array(Schema.String))(xs);
  const findings: readonly Finding[] = ok.map(key => ({ key }));
  const pastDue = findings.filter(f => f.key === "");
  return { findings, pastDue };
});
class RunError extends Data.TaggedError("RunError")<{ readonly detail: string }> {}
export const scoped = Effect.fn("scoped")(function* (n: number) {
  yield* Effect.acquireRelease(Effect.succeed(n), () => Effect.void);
  if (n < 0) return yield* new RunError({ detail: "negative" });
  return { _tag: "Done" as const, n };
}, Effect.scoped);
export const mapped = Effect.fn("mapped")(function* (n: number) {
  if (n < 0) return yield* new RunError({ detail: "negative" });
  return n;
}, Effect.map(n => ({ _tag: "Mapped" as const, n })));
