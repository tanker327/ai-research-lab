// pino root + child-logger factory. Convention (CLAUDE.md): children are scoped
// { runId, taskId, attemptId }; no console.log outside scripts.
import pino from "pino";

export type LogScope = { runId?: string; taskId?: string; attemptId?: string };

export function createLogger(name: string, level: string = process.env.LOG_LEVEL ?? "info") {
  return pino({ name, level });
}

export function scoped(logger: pino.Logger, scope: LogScope): pino.Logger {
  return logger.child(scope);
}
