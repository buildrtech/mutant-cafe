import type { Mutant, RunConfig, Viability } from "@mutant-cafe/core";

export interface Value {
  readonly text: string;
  readonly synthetic: boolean;
}

export interface TaggedValue extends Value {
  readonly tag: string;
}

export type ReturnShape =
  | { readonly kind: "Effect" | "Stream"; readonly values: ReadonlyArray<Value>; readonly errors: ReadonlyArray<TaggedValue> }
  | { readonly kind: "Option"; readonly values: ReadonlyArray<Value> }
  | { readonly kind: "Layer"; readonly errors: ReadonlyArray<TaggedValue>; readonly service: string | undefined }
  | { readonly kind: "Boolean" | "Literal" | "Void" | "Value"; readonly values: ReadonlyArray<Value> };

export interface MutableFunction {
  readonly file: string;
  readonly name: string;
  readonly returnType: string;
  readonly displayReturnType: string;
  readonly equivalentValues: ReadonlyArray<string>;
  readonly span: Mutant["span"];
  readonly startOffset: number;
  readonly endOffset: number;
  readonly original: string;
  readonly literal: string | undefined;
  readonly block: boolean;
  readonly generator: boolean;
  readonly shape: ReturnShape;
  /** Resolve an API to an existing value import; mutations never add imports. */
  readonly api: (module: "Effect" | "Option" | "Stream" | "Layer", member: string) => string | undefined;
}

/** Compiler-specific state stays behind this port. A future adapter can use tsgo. */
export interface TypeOracle {
  readonly discover: (config: RunConfig) => Iterable<MutableFunction>;
  readonly checkViable: (mutant: Mutant) => Viability;
}
