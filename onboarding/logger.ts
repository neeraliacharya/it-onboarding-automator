/**
 * onboarding/logger.ts
 *
 * Lightweight structured logger used across the entire project
 * (API, provisioner, MCP server).
 *
 * Rules:
 *  - All output goes to process.stderr only — never stdout.
 *  - Output is newline-delimited JSON:
 *      {"level":"info","ts":"2024-01-01T10:00:00.000Z","msg":"...","...extras"}
 *  - Minimum level is controlled by LOG_LEVEL env var (default "info").
 *    Valid values: debug | info | warn | error
 *  - Never throws — falls back to a plain string write if JSON.stringify fails.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function minLevelRank(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVEL_RANK[raw] ?? LEVEL_RANK.info;
}

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < minLevelRank()) return;

  const entry: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...extra,
  };

  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // JSON.stringify can fail on circular structures — fall back to plain text.
    process.stderr.write(`${level} ${msg}\n`);
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>): void =>
    log('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>): void =>
    log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>): void =>
    log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>): void =>
    log('error', msg, extra),
};
