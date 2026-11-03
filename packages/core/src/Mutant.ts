import * as Schema from "effect/Schema";

export const Genre = Schema.Literals([
  "EffectSucceed",
  "EffectFail",
  "SwallowTag",
  "TagToDefect",
  "EffectDie",
  "EffectNever",
  "OptionNone",
  "OptionSome",
  "StreamEmpty",
  "StreamOne",
  "StreamFail",
  "LayerFail",
  "LayerDie",
  "SchemaAcceptAnything",
  "BooleanFlip",
  "LiteralCycle",
  "FnValue",
]);
export type Genre = typeof Genre.Type;

export const Span = Schema.Struct({
  start: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
  end: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
});
export type Span = typeof Span.Type;

export const Replacement = Schema.Struct({
  startOffset: Schema.Int,
  endOffset: Schema.Int,
  text: Schema.String,
});
export type Replacement = typeof Replacement.Type;

export const Mutant = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  functionName: Schema.String,
  returnType: Schema.String,
  displayReturnType: Schema.optional(Schema.String),
  genre: Genre,
  description: Schema.String,
  span: Span,
  replacement: Replacement,
  synthetic: Schema.Boolean,
});
export type Mutant = typeof Mutant.Type;

export const Outcome = Schema.Literals(["caught", "missed", "unviable", "timeout", "untested", "unreliable"]);
export type Outcome = typeof Outcome.Type;

export const MutantResult = Schema.Struct({
  mutant: Mutant,
  outcome: Outcome,
  durationMs: Schema.Int,
  testCommand: Schema.Array(Schema.String),
  diagnostics: Schema.Array(Schema.String),
  output: Schema.optional(Schema.String),
});
export type MutantResult = typeof MutantResult.Type;

export const Baseline = Schema.Struct({
  durationMs: Schema.Int,
  testCommand: Schema.Array(Schema.String),
  unreliable: Schema.optional(Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.String }))),
});
export type Baseline = typeof Baseline.Type;

export const NotMutated = Schema.Struct({
  file: Schema.String,
  functionName: Schema.String,
  reason: Schema.String,
});
export type NotMutated = typeof NotMutated.Type;

export const RunReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  tool: Schema.Literal("mutant.cafe"),
  root: Schema.String,
  baseline: Baseline,
  timeoutMs: Schema.Int,
  results: Schema.Array(MutantResult),
  failure: Schema.optional(Schema.String),
});
export type RunReport = typeof RunReport.Type;
