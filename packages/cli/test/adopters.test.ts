import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MutantSource, Scratch, TestRunner, TestSpawnError, type Mutant } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { runCli } from "../src/Command.ts";

// Setup-error rendering only: the runner port rejects before any mutation executes.
it.live("prints an unsupported Vitest version as a setup error with exit 8, not baseline failure or internal error", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const console = yield* Console.Console;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-version-" });
  yield* fs.writeFileString(`${root}/value.ts`, "export const value = (): boolean => true;");
  const mutant: Mutant = { id: "version-setup", file: "value.ts", functionName: "value", returnType: "boolean",
    genre: "BooleanFlip", description: "replace value with false", synthetic: false,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 42 } },
    replacement: { startOffset: 38, endOffset: 42, text: "false" } };
  const errors: string[] = [];
  const code = yield* runCli({ root, args: [], run: () => new TestSpawnError({
    kind: "vitest-version", command: ["vitest"], message: "mutant.cafe needs vitest >= 5.0, found 4.1.12"
  }) }).pipe(
    Effect.provideService(MutantSource, { generate: () => Stream.make(mutant), notMutated: () => Effect.succeed([]), checkViable: () => Effect.die("Unexpected viability") }),
    Effect.provideService(Scratch, { acquire: () => Effect.die("Unexpected scratch") }),
    Effect.provideService(TestRunner, { baseline: () => Effect.die("Unexpected baseline"), runRelated: () => Effect.die("Unexpected execution") }),
    Effect.provideService(Console.Console, { ...console, error: (...args: ReadonlyArray<unknown>) => { errors.push(args.join(" ")); } })
  );
  expect(code).toBe(8);
  expect(errors).toEqual(["mutant.cafe needs vitest >= 5.0, found 4.1.12"]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
