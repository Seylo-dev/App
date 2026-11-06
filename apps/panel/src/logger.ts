// Structured JSON logs (pino). Library code takes a Logger argument rather
// than importing a global, so tests can pass a silent one. Keys are
// camelCase (opId, nodeId); never log secrets, tokens or env values.

import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}

export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
