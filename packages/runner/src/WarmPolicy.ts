// Shared verbatim with the target-process host and policy regression tests.
export const warmPolicySource = String.raw`
function warmRefusal(version, ctx, selectionOnly = false) {
  if (!/^5\./.test(version)) return "unverified Vitest major: " + version + " (verified: 5)";
  if (!ctx) return null;
  const writable = (object, key) => {
    while (object) {
      const field = Object.getOwnPropertyDescriptor(object, key);
      if (field) return field.writable === true;
      object = Object.getPrototypeOf(object);
    }
    return false;
  };
  for (const key of ["pool", "cancelPromise", "runningPromise", "configOverride", "reporters", "initializeGlobalSetup"])
    if (!(key in ctx) || !writable(ctx, key)) return "unsupported private field: " + key;
  if (!Object.isExtensible(ctx) || !Object.isExtensible(ctx.configOverride) || typeof ctx.watcher?.invalidates?.add !== "function" || typeof ctx.vite?.transformRequest !== "function")
    return "unsupported transform/invalidation boundary";
  if (!Object.isExtensible(ctx.config) || ctx.projects.some(project => !project.vite?.environments || Object.values(project.vite.environments).some(environment => typeof environment.moduleGraph?.getModulesByFile !== "function")))
    return "unsupported private module graph";
  if (selectionOnly) return null;
  for (const config of [ctx.config, ...ctx.projects.flatMap(project => [project.config, project.vite.config.test ?? {}])]) {
    if (config.globalSetup && (!Array.isArray(config.globalSetup) || config.globalSetup.length)) return "globalSetup requires cold execution for per-mutant parity";
    if (config.browser?.enabled || (config.pool !== undefined && !["forks", "threads"].includes(config.pool))) return "unsupported warm pool: " + (config.browser?.enabled ? "browser" : (typeof config.pool === "string" ? config.pool : "custom"));
  }
  return null;
}
`;

export const workerDeathSource = String.raw`
function workerDied(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const description = String(error.name ?? "") + " " + String(error.message ?? "");
  const diagnostic = typeof error.message === "string" || typeof error.stack === "string" || typeof error.code === "string";
  return (diagnostic && (/worker.*(?:exited|exit code|signal|terminated|died)|WorkerExit|WorkerUnexpectedExit/i.test(description)
    || ["ERR_WORKER_OUT_OF_MEMORY", "ERR_WORKER_NOT_RUNNING"].includes(error.code)
    || (/worker/i.test(description) && (typeof error.signal === "string" || typeof error.exitCode === "number"))))
    || workerDied(error.cause, seen) || workerDied(error.error, seen) || workerDied(error.result, seen)
    || (Array.isArray(error.errors) && error.errors.some(item => workerDied(item, seen)))
    || (Array.isArray(error.tasks) && error.tasks.some(item => workerDied(item, seen)));
}
`;
