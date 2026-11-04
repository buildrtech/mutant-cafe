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
  return Math.max(0, copies - observed.length) * Math.max(0, ...observed);
}

/** Only future costs matter: samples and opened-copy startup are already paid. */
export function chooseMode(sample: Calibration): "warm" | "cold" {
  const fixedSaving = (sample.coldStartupMs ?? 0) - (sample.warmRunStartupMs ?? 0);
  const savingPerFile = (sample.coldMs - sample.warmMs - fixedSaving) / Math.max(1, sample.testFiles);
  const savingPerMutant = fixedSaving + savingPerFile;
  return sample.warmMs * 10 <= sample.coldMs * 9 &&
    savingPerMutant * sample.mutants > sample.warmStartupMs ? "warm" : "cold";
}
