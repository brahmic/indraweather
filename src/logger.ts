import pino from "pino";

export function createLogger(level: string) {
  return pino({ level, base: null });
}

export type Logger = ReturnType<typeof createLogger>;
