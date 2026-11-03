// Opt-in, local JSONL diagnostics. Never record argv, environments or tokens.
// Shared verbatim by the ownership preload and generated Vitest reporter.
export const processTraceSource = String.raw`
import { appendFileSync as appendProcessTrace } from "node:fs";
const traceProcess = (stage, details = {}) => {
  const destination = process.env.MUTANT_CAFE_PROCESS_TRACE;
  if (destination) try {
    appendProcessTrace(destination, JSON.stringify({ at: Date.now(), pid: process.pid, ppid: process.ppid, stage, ...details }) + "\n");
  } catch { /* Diagnostics cannot determine a verdict or prevent cleanup. */ }
};
`;
