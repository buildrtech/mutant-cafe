// A content digest is pure synchronous work; Effect 4.1.2 has no Crypto module.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import type { Genre, Mutant } from "@mutant-cafe/core";
import type { MutableFunction, Value } from "./TypeOracle.ts";

/** Pure generation over the oracle's compiler-independent description. */
export function* generateFunction(fn: MutableFunction): Generator<Mutant> {
  const api = fn.api;
  const candidate = (genre: Genre, expression: string, value: Value = { text: "", synthetic: false }, detail = ""): Mutant => {
    const text = fn.block
      ? `{ return ${fn.generator ? "yield* " : ""}${expression}; }`
      : `(${expression})`;
    return makeMutant(fn, genre, text, value.synthetic, detail);
  };
  const shape = fn.shape;
  switch (shape.kind) {
    case "Effect": {
      const succeed = api("Effect", "succeed");
      if (succeed) {
        for (const value of shape.values) yield candidate("EffectSucceed", `${succeed}(${value.text})`, value);
      }
      const fail = api("Effect", "fail");
      const catchTag = api("Effect", "catchTag");
      for (const error of shape.errors) {
        if (fail) yield candidate("EffectFail", `${fail}(${error.text})`, error, error.tag);
        const value = shape.values[0];
        const die = api("Effect", "die");
        const recovery = value && succeed ? `${succeed}(${value.text})`
          : die ? `${die}(${JSON.stringify(`mutant.cafe: swallowed ${error.tag}`)})` : undefined;
        if (catchTag && recovery) {
          // Evaluate the original body, rather than replacing its error path with an unconditional failure.
          const gen = api("Effect", "gen");
          const original = fn.generator
            ? gen && `((): ${fn.returnType} => ${gen}(function* () ${fn.original}))()`
            : fn.block ? `((): ${fn.returnType} => ${fn.original})()` : `((): ${fn.returnType} => (${fn.original}))()`;
          if (original) yield candidate("SwallowTag", `${original}.pipe(${catchTag}(${JSON.stringify(error.tag)}, () => ${recovery}))`, value, value ? error.tag : `${error.tag}; die: no value of A`);
        }
      }
      const die = api("Effect", "die");
      if (die) yield candidate("EffectDie", `${die}("mutant.cafe")`);
      const never = api("Effect", "never");
      if (never) yield candidate("EffectNever", never);
      break;
    }
    case "Option": {
      const none = api("Option", "none");
      const some = api("Option", "some");
      if (none) yield candidate("OptionNone", `${none}()`);
      if (some) for (const value of shape.values) yield candidate("OptionSome", `${some}(${value.text})`, value);
      break;
    }
    case "Stream": {
      const empty = api("Stream", "empty");
      const make = api("Stream", "make");
      const fail = api("Stream", "fail");
      if (empty) yield candidate("StreamEmpty", empty);
      if (make) for (const value of shape.values) yield candidate("StreamOne", `${make}(${value.text})`, value);
      if (fail) for (const error of shape.errors) yield candidate("StreamFail", `${fail}(${error.text})`, error, error.tag);
      break;
    }
    case "Layer": {
      const layer = api("Layer", "effect");
      const fail = api("Effect", "fail");
      if (layer && fail && shape.service) {
        for (const error of shape.errors) yield candidate("LayerFail", `${layer}(${shape.service}, ${fail}(${error.text}))`, error, error.tag);
      }
      break;
    }
    case "Void":
      yield makeMutant(fn, "FnValue", "{}", false, "");
      break;
    default: {
      const genre = shape.kind === "Boolean" ? "BooleanFlip" : shape.kind === "Literal" ? "LiteralCycle" : "FnValue";
      for (const value of shape.values) {
        if (shape.kind === "Literal" && value.text === fn.literal) continue;
        yield candidate(genre, value.text, value);
      }
    }
  }
}

function makeMutant(fn: MutableFunction, genre: Genre, text: string, synthetic: boolean, detail: string): Mutant {
  const replacement = { startOffset: fn.startOffset, endOffset: fn.endOffset, text };
  const id = createHash("sha256").update(JSON.stringify([fn.file, fn.span, genre, text])).digest("hex").slice(0, 24);
  return {
    id, file: fn.file, functionName: fn.name, returnType: fn.returnType, genre,
    description: `${genre}${detail ? `(${detail})` : ""} in ${fn.name}`,
    span: fn.span, replacement, synthetic,
  };
}
