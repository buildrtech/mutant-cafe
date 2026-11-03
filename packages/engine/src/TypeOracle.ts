import type { Mutant, NotMutated, RunConfig, Viability } from "@mutant-cafe/core";

export interface Value {
  readonly text: string;
  readonly synthetic: boolean;
}

export type TaggedValue =
  | (Value & { readonly tag: string; readonly reason?: never })
  | { readonly tag: string; readonly reason: string; readonly text?: never; readonly synthetic?: never };

export type ReturnShape = (
  | { readonly kind: "Effect" | "Stream"; readonly values: ReadonlyArray<Value>; readonly errors: ReadonlyArray<TaggedValue> }
  | { readonly kind: "Option"; readonly values: ReadonlyArray<Value> }
  | { readonly kind: "Layer"; readonly errors: ReadonlyArray<TaggedValue> }
  | { readonly kind: "Boolean" | "Literal" | "Void" | "Value"; readonly values: ReadonlyArray<Value> }
) & { readonly omittedValues?: number };

export interface MutableFunction {
  readonly file: string;
  readonly name: string;
  readonly returnType: string;
  readonly displayReturnType: string;
  readonly equivalentValues: ReadonlyArray<string>;
  readonly skipReason?: string;
  readonly notices?: ReadonlyArray<string>;
  readonly functionSpan?: Mutant["span"];
  readonly functionLike?: boolean;
  readonly span: Mutant["span"];
  readonly startOffset: number;
  readonly endOffset: number;
  readonly original: string;
  readonly literal: string | undefined;
  readonly block: boolean;
  readonly generator: boolean;
  readonly shape: ReturnShape;
  readonly identityFile?: string;
  readonly identityOrdinal?: number;
  readonly logicalSpan?: { readonly offset: number; readonly length: number };
  readonly importInsertionOffset?: number;
  readonly sourcePrefix?: string;
  readonly extraImports?: ReadonlyArray<{ readonly namespace: string; readonly statement: string }>;
  /** Resolve an API to an existing import or a collision-free mutation import. */
  readonly api: (module: "Effect" | "Option" | "Stream" | "Layer", member: string) => string | undefined;
}

/** Compiler-specific state stays behind this port. A future adapter can use tsgo. */
export interface TypeOracle {
  readonly discover: (config: RunConfig) => {
    readonly functions: ReadonlyArray<MutableFunction>;
    readonly notMutated: ReadonlyArray<NotMutated>;
  };
  readonly checkViable: (mutant: Mutant) => Viability;
}
