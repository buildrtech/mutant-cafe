import type { RunReport } from "@mutant-cafe/core";
import type * as Path from "effect/Path";
import { reportExitCode } from "./ExitCode.ts";

export const outcomeNames = ["caught", "missed", "timeout", "unviable", "untested", "unreliable"] as const;

export const countsLine = (report: RunReport, notMutated: number): string =>
  `${report.selected ?? report.results.length} selected, ${report.run ?? report.results.length} run, ${report.budgetSkipped ?? 0} budget-skipped; ` +
  outcomeNames.map(outcome => `${report.results.filter(result => result.outcome === outcome).length} ${outcome}`).join(", ") +
  `; ${notMutated} not mutated`;

// HTML entities avoid starting code spans; backslashes protect table separators.
const cell = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("`", "&#96;").replace(/[\r\n]+/g, " ");

export const markdownSummary = (options: {
  readonly report: RunReport;
  readonly root: string;
  readonly gitRoot: string;
  readonly path: Path.Path;
  readonly marker: string;
  readonly notMutated: number;
  readonly advisory: boolean;
}): string => {
  const { report, path } = options;
  const rows = report.results.filter(result => result.outcome === "missed" || result.outcome === "timeout" || result.outcome === "untested" || result.outcome === "unreliable");
  const exit = report.failure?.startsWith("BaselineFailed") ? 4 : reportExitCode(report);
  return [options.marker, countsLine(report, options.notMutated), "",
    ...(report.failure === undefined ? [] : [`Failure: ${cell(report.failure)}`, ""]),
    options.advisory ? `Advisory: would exit ${exit} without --advisory.` : `Exit code: ${exit}.`, "",
    ...(rows.length ? ["| File:line | Function | Description | Outcome |", "| --- | --- | --- | --- |"] : report.failure === undefined ? ["No actionable mutants."] : []),
    ...rows.slice(0, 50).map(({ mutant, outcome }) => `| ${cell(path.relative(options.gitRoot, path.resolve(options.root, mutant.file)).replaceAll("\\", "/"))}:${mutant.span.start.line} | ${cell(mutant.functionName)} | ${cell(mutant.description)} | ${outcome} |`),
    ...(rows.length > 50 ? ["", `and ${rows.length - 50} more`] : []), "",
  ].join("\n");
};
