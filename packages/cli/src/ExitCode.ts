import type { RunReport } from "@mutant-cafe/core";

export const reportExitCode = (report: RunReport): number =>
  report.results.some((result) => result.outcome === "missed" || result.outcome === "untested" || result.outcome === "unreliable") ? 2 :
    report.results.some((result) => result.outcome === "timeout") ? 3 : 0;

export const errorExitCode = (error: { readonly _tag: string }): number => {
  switch (error._tag) {
    case "BaselineFailed": return 4;
    case "DiffMismatch": return 5;
    case "DiffParseError": return 6;
    case "UsageError": case "ShowHelp": case "InvalidValue": case "MissingFlag":
    case "UnrecognizedArgument": return 1;
    default: return 70;
  }
};
