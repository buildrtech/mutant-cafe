#!/usr/bin/env -S node --experimental-strip-types
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MutantSourceLive } from "@mutant-cafe/engine";
import { runMutants, ScratchLive, TestRunnerLive } from "@mutant-cafe/runner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { runCli, type Run } from "./Command.ts";

const run: Run = (config, mutants) => runMutants(config, Stream.fromIterable(mutants));

const live = Layer.mergeAll(MutantSourceLive, ScratchLive, TestRunnerLive).pipe(
  Layer.provideMerge(NodeServices.layer)
);

const main = Effect.gen(function* () {
  const code = yield* runCli({ root: process.cwd(), args: process.argv.slice(2), run });
  yield* Effect.sync(() => {
    process.exitCode = code;
  });
}).pipe(Effect.provide(live));

NodeRuntime.runMain(main);
