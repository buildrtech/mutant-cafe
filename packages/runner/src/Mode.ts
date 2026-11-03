export interface Calibration {
  readonly coldMs: number;
  readonly warmMs: number;
  readonly warmStartupMs: number;
  readonly testFiles: number;
  readonly mutants: number;
}

/** Conservatively amortize calibration over one affected file per mutant. */
export function chooseMode(sample: Calibration): "warm" | "cold" {
  const savingPerFile = (sample.coldMs - sample.warmMs) / Math.max(1, sample.testFiles);
  return sample.warmMs * 10 <= sample.coldMs * 9 &&
    savingPerFile * sample.mutants > sample.warmStartupMs + sample.warmMs ? "warm" : "cold";
}
