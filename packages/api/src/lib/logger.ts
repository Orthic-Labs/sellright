/**
 * Structured logger — OBS-1.
 *
 * The thin surface (`log` / `err`) keeps callers tiny and lets the transport
 * (pino) be swapped without touching every callsite. Every line is one JSON
 * object, so log aggregators can index fields without parsing a sentence.
 *
 * Fields every log line carries:
 *   - level, time, msg, pid, hostname  (pino defaults)
 *   - requestId, storeId               (when bound via withContext)
 *
 * Why a wrapper instead of importing pino directly:
 *   - Tests can stub the singleton without rewriting every consumer.
 *   - Routes can opt into a per-request child logger via `logger.child({ requestId })`.
 *   - We never expose `pino.stdSerializers` or transports here; the only
 *     optional is the log level, which falls back to `info` in production and
 *     `debug` in development. Stdout is the only destination — collectors run
 *     alongside the process.
 */
import pino, { type Logger as PinoLogger } from 'pino';
// One process-wide base logger, created on first use (importing this module
// must not read the env: createApp parses it, plan 2.1). Re-using the same
// instance keeps child loggers cheap (pino interns them). `resetLogger()` is
// called by createApp after it parses its env so the level reflects it.
let baseInstance: PinoLogger | undefined;
let nodeEnvOverride: string | undefined;

function createBase(): PinoLogger {
  const nodeEnv = nodeEnvOverride ?? process.env.NODE_ENV;
  return pino({
    level: nodeEnv === 'production' ? 'info' : 'debug',
    // ISO timestamps beat ms-since-epoch in shipped logs.
    timestamp: pino.stdTimeFunctions.isoTime,
    // Keep the default field names — collectors parse on `time`, `level`, `msg`.
    base: { service: 'sellright-api' },
  });
}

function getBase(): PinoLogger {
  return (baseInstance ??= createBase());
}

/** Drop the cached base logger so the next line re-reads the level (createApp passes its parsed NODE_ENV). */
export function resetLogger(nodeEnv?: string): void {
  nodeEnvOverride = nodeEnv;
  baseInstance = undefined;
}

/**
 * Bound (child) loggers carry requestId + storeId once and emit every line
 * with those fields merged. Use inside a request handler:
 *
 *     const log = withContext({ requestId: c.var.requestId, storeId: st?.id });
 *     log.info('order placed');
 */
export type RequestContext = {
  requestId?: string;
  storeId?: string;
};

export function withContext(ctx: RequestContext): PinoLogger {
  const bindings: Record<string, string> = {};
  if (ctx.requestId) bindings.requestId = ctx.requestId;
  if (ctx.storeId) bindings.storeId = ctx.storeId;
  return bindings.requestId || bindings.storeId ? getBase().child(bindings) : getBase();
}

/** Get the raw base logger — for cases where bindings don't fit. */
export function baseLogger(): PinoLogger {
  return getBase();
}

/**
 * `log` — info-level logger by default. Routes use this when they want a
 * structured info line (replaces `console.log` at high-value sites).
 */
export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => getBase().info(fields ?? {}, msg),
  warn: (msg: string, fields?: Record<string, unknown>) => getBase().warn(fields ?? {}, msg),
  debug: (msg: string, fields?: Record<string, unknown>) => getBase().debug(fields ?? {}, msg),
};

/**
 * `err` — error-level logger. Carries the error object as `err` so pino's
 * stdErrorSerializer can format it (stack + message + cause chain) instead of
 * the unhelpful `Error: <msg>` string-only that `console.error(e)` produces.
 *
 * Callers should NOT downgrade severity here — if it was a console.error, it
 * stays an error log line.
 */
export const err = {
  error: (msg: string, error?: unknown, fields?: Record<string, unknown>) => {
    if (error === undefined) getBase().error(fields ?? {}, msg);
    else getBase().error({ ...(fields ?? {}), err: error }, msg);
  },
};