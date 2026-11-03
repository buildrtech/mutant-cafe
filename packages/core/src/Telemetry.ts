import type { RunReport } from "./Mutant.ts";

export const telemetryInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const numericRecord = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(finite);
const calibration = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) &&
  ["coldMs", "warmMs", "warmStartupMs", "testFiles", "mutants"].every(key => telemetryInteger(Reflect.get(value, key))) && Object.values(value).every(item => item === undefined || telemetryInteger(item));
const validators: Readonly<Record<string, (value: unknown) => boolean>> = {
  durationMs: telemetryInteger, timeoutMs: telemetryInteger, outerTimeoutMs: telemetryInteger, startupMs: telemetryInteger,
  testWorkers: telemetryInteger, testConcurrency: telemetryInteger, hostPid: telemetryInteger, testableMutants: telemetryInteger,
  hostRestarts: telemetryInteger, poolResets: telemetryInteger, firstTestStart: finite, hangBudgetBaseMs: finite,
  testDurations: numericRecord, testTimeouts: numericRecord, testFileDurations: numericRecord, testTimeoutDetails: numericRecord, calibration,
  runnerMode: value => value === "cold" || value === "warm",
  telemetryWarnings: value => Array.isArray(value) && value.every(item => typeof item === "string")
};
const describe = (value: unknown) => typeof value === "string" ? JSON.stringify(value.slice(0, 128)) : value === null || typeof value !== "object" ? String(value) : "[object]";

/** Retain outcomes when ancillary data is malformed. Never mutate the input. */
export function cleanTelemetry<T extends object>(input: T, location: string, required: ReadonlyArray<string> = ["durationMs"]): { value: T; warnings: string[] } {
  const value = { ...input };
  const warnings: string[] = [];
  for (const [key, valid] of Object.entries(validators)) {
    const item: unknown = Reflect.get(value, key);
    if (item === undefined || valid(item)) continue;
    warnings.push(`Internal reporter telemetry error: ${location}.${key}=${describe(item)}; ${required.includes(key) ? "using zero" : "omitted"}`);
    if (required.includes(key)) Reflect.set(value, key, 0);
    else Reflect.deleteProperty(value, key);
  }
  return { value, warnings };
}

export function sanitizeReportTelemetry(report: RunReport): { report: RunReport; warnings: string[] } {
  const root = cleanTelemetry(report, "report", ["timeoutMs"]);
  const baseline = cleanTelemetry(report.baseline, "baseline");
  const results = report.results.map((result, index) => cleanTelemetry(result, `results[${index}]`));
  const warnings = [...new Set([...root.warnings, ...baseline.warnings, ...(baseline.value.telemetryWarnings ?? []), ...results.flatMap(result => [...result.warnings, ...(result.value.telemetryWarnings ?? [])])])];
  return { report: { ...root.value, baseline: { ...baseline.value, ...(warnings.length ? { telemetryWarnings: warnings } : {}) }, results: results.map(result => result.value) }, warnings };
}
