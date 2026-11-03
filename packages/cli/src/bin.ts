#!/usr/bin/env -S node --experimental-strip-types
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

// The integration packet replaces this boundary with the live core service layers.
NodeRuntime.runMain(Console.error("mutant-cafe: runtime layers are not wired in this library build").pipe(
  Effect.tap(() => Effect.sync(() => { process.exitCode = 70; })),
));
