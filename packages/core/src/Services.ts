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
import type { Baseline, Mutant, MutantResult, NotMutated, ReachabilityProbe, RunReport } from "./Mutant.ts";

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
  readonly poison?: (mutant: Mutant, signal: string, token: string) => Effect.Effect<void, ScratchError>;
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
  readonly testDurations?: Readonly<Record<string, number>>;
  readonly testTimeouts?: Readonly<Record<string, number>>;
  readonly testWorkers?: number;
  readonly testConcurrency?: number;
  readonly testFileDurations?: Readonly<Record<string, number>>;
  readonly startupMs?: number;
  readonly probeSupported?: boolean;
  readonly probeLoaded?: boolean;
}

export class TestRunner extends Context.Service<
  TestRunner,
  {
    readonly open?: (dir: ScratchDir, cold: boolean, warm?: boolean, mutants?: number) => Effect.Effect<void, TestSpawnError, Scope.Scope>;
    readonly invalidate?: (dir: ScratchDir, file: string) => Effect.Effect<void, TestSpawnError>;
    readonly selectRelated?: (dir: ScratchDir, file: string) => Effect.Effect<ReadonlyArray<string> | undefined, TestSpawnError>;
    readonly probeReachability?: (dir: ScratchDir, mutant: Mutant, timeoutMs: number) => Effect.Effect<ReachabilityProbe, ScratchError | TestSpawnError>;
    readonly baseline: (dir: ScratchDir, tsconfig?: string) => Effect.Effect<Baseline, BaselineFailed | TestSpawnError>;
    readonly runRelated: (
      dir: ScratchDir,
      file: string,
      timeoutMs: number,
      testTimeoutMs?: number
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
