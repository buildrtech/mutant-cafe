import { Data, Effect } from "effect";
type Expanding<T> = { readonly head: T; readonly tail: Expanding<readonly T[]> };
export const recursive = (): Expanding<string> => { throw new Error("fixture"); };
type Wide = { readonly config: { readonly [K in "field0" | "field1" | "field2" | "field3" | "field4" | "field5" | "field6" | "field7" | "field8" | "field9" | "field10" | "field11" | "field12" | "field13" | "field14" | "field15" | "field16" | "field17" | "field18" | "field19" | "field20" | "field21" | "field22" | "field23" | "field24" | "field25" | "field26" | "field27" | "field28" | "field29" | "field30" | "field31" | "field32" | "field33" | "field34" | "field35" | "field36" | "field37" | "field38" | "field39" | "field40" | "field41" | "field42" | "field43" | "field44" | "field45" | "field46" | "field47" | "field48" | "field49" | "field50" | "field51" | "field52" | "field53" | "field54" | "field55" | "field56" | "field57" | "field58" | "field59" | "field60" | "field61" | "field62" | "field63" | "field64" | "field65" | "field66" | "field67" | "field68" | "field69" | "field70" | "field71" | "field72" | "field73" | "field74" | "field75" | "field76" | "field77" | "field78" | "field79" | "field80" | "field81" | "field82" | "field83" | "field84" | "field85" | "field86" | "field87" | "field88" | "field89" | "field90" | "field91" | "field92" | "field93" | "field94" | "field95" | "field96" | "field97" | "field98" | "field99" | "field100" | "field101" | "field102" | "field103" | "field104" | "field105" | "field106" | "field107" | "field108" | "field109" | "field110" | "field111" | "field112" | "field113" | "field114" | "field115" | "field116" | "field117" | "field118" | "field119" | "field120" | "field121" | "field122" | "field123" | "field124" | "field125" | "field126" | "field127" | "field128" | "field129" | "field130" | "field131" | "field132" | "field133" | "field134" | "field135" | "field136" | "field137" | "field138" | "field139" | "field140" | "field141" | "field142" | "field143" | "field144" | "field145" | "field146" | "field147" | "field148" | "field149" | "field150" | "field151" | "field152" | "field153" | "field154" | "field155" | "field156" | "field157" | "field158" | "field159"]: { readonly value: number } } };
export const wide = (): Wide => { throw new Error("fixture"); };
export type Diagnostic = { readonly kind: "K0"; readonly message: string } | { readonly kind: "K1"; readonly message: string } | { readonly kind: "K2"; readonly message: string } | { readonly kind: "K3"; readonly message: string } | { readonly kind: "K4"; readonly message: string } | { readonly kind: "K5"; readonly message: string } | { readonly kind: "K6"; readonly message: string } | { readonly kind: "K7"; readonly message: string } | { readonly kind: "K8"; readonly message: string } | { readonly kind: "K9"; readonly message: string };
export const diagnostic = (flag: boolean): Diagnostic => ({ kind: "K9", message: flag ? "detailed" : "another" });
export const nine = (n: number): "v0" | "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7" | "v8" => n ? "v0" : "v8";
export const literal = (): "a" | "b" | "c" => "b";
class First extends Data.TaggedError("First") {}
class Second extends Data.TaggedError("Second") {}
export const many = (): Effect.Effect<Diagnostic, First | Second> => Effect.fail(new First());
export const four = (): Effect.Effect<"a" | "b" | "c" | "d", First | Second> => Effect.fail(new First());
export const numeric = (): Effect.Effect<number, First | Second> => Effect.fail(new First());
export const text = (): Effect.Effect<string, First | Second> => Effect.fail(new First());
export const struct = (): Effect.Effect<{ readonly state: "on" | "off" }, First | Second> => Effect.fail(new First());
/** @mutants-skip */
export const excluded = (n: number): string => [n].map(x => String(x)).join(",");
const internal = (n: number): string => [n].map(x => String(x)).join(",");
export const exported = (n: number) => internal(n);
