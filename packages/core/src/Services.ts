import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { RunConfig } from "./Config.ts";
import type {
  BaselineFailed,
  ProgramLoadError,
  ReportWriteError,
  ScratchError,
  TestSpawnError,
} from "./Errors.ts";
import type { Baseline, Mutant, MutantResult, NotMutated, RunReport } from "./Mutant.ts";

export type Viability =
  | { readonly viable: boolean; readonly diagnostics: ReadonlyArray<string>; readonly analysisFailed?: never }
  | { readonly viable: false; readonly diagnostics: ReadonlyArray<string>; readonly analysisFailed: NotMutated };

export class MutantSource extends Context.Service<
  MutantSource,
  {
    readonly notMutated: (config: RunConfig) => Effect.Effect<ReadonlyArray<NotMutated>, ProgramLoadError>;
    readonly generate: (config: RunConfig) => Stream.Stream<Mutant, ProgramLoadError>;
    readonly checkViable: (mutant: Mutant) => Effect.Effect<Viability, ProgramLoadError>;
  }
>()("mutant.cafe/MutantSource") {}

export interface ScratchDir {
  readonly path: string;
  readonly apply: (mutant: Mutant) => Effect.Effect<void, ScratchError>;
  readonly revert: (mutant: Mutant) => Effect.Effect<void, ScratchError>;
}

export class Scratch extends Context.Service<
  Scratch,
  {
    readonly acquire: (root: string) => Effect.Effect<ScratchDir, ScratchError, Scope.Scope>;
  }
>()("mutant.cafe/Scratch") {}

export type TestStatus = "passed" | "failed" | "timedOut" | "untested";

export interface TestRun {
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly command: ReadonlyArray<string>;
  readonly output: string;
  readonly testsCollected?: boolean;
  readonly testFiles?: ReadonlyArray<string>;
}

export class TestRunner extends Context.Service<
  TestRunner,
  {
    readonly baseline: (dir: ScratchDir, tsconfig?: string) => Effect.Effect<Baseline, BaselineFailed | TestSpawnError>;
    readonly runRelated: (
      dir: ScratchDir,
      file: string,
      timeoutMs: number
    ) => Effect.Effect<TestRun, TestSpawnError>;
  }
>()("mutant.cafe/TestRunner") {}

export class Reporter extends Context.Service<
  Reporter,
  {
    readonly progress: (result: MutantResult) => Effect.Effect<void>;
    readonly write: (report: RunReport) => Effect.Effect<void, ReportWriteError>;
  }
>()("mutant.cafe/Reporter") {}
