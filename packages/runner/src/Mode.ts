export interface Calibration {
  readonly coldMs: number;
  readonly warmMs: number;
  readonly warmStartupMs: number;
  readonly testFiles: number;
  readonly mutants: number;
  readonly overheadMs?: number | undefined;
  readonly coldStartupMs?: number | undefined;
  readonly warmRunStartupMs?: number | undefined;
}

export function startupCost(observed: ReadonlyArray<number>, copies: number): number {
  return Math.max(observed.reduce((sum, duration) => sum + duration, 0), Math.max(0, ...observed) * copies);
}

/** Conservatively amortize calibration over one affected file per mutant. */
export function chooseMode(sample: Calibration): "warm" | "cold" {
  const fixedSaving = (sample.coldStartupMs ?? 0) - (sample.warmRunStartupMs ?? 0);
  const savingPerFile = (sample.coldMs - sample.warmMs - fixedSaving) / Math.max(1, sample.testFiles);
  const savingPerMutant = fixedSaving + savingPerFile;
  return sample.warmMs * 10 <= sample.coldMs * 9 &&
    savingPerMutant * sample.mutants > sample.warmStartupMs + (sample.overheadMs ?? sample.warmMs) ? "warm" : "cold";
}
