/**
 * Structured logging (Pino) with automatic correlation-id enrichment.
 *
 * IMPORTANT: in stdio transport mode logs MUST go to stderr — stdout is the
 * JSON-RPC protocol channel and any stray write corrupts the stream. The
 * composition root passes `destination: 'stderr'` when booting stdio.
 */
import pino from 'pino';
import { getRequestContext } from './request-context.js';

export type Logger = pino.Logger;

export interface LoggerOptions {
  level: string;
  name: string;
  /** Pretty-print for local development only. */
  pretty?: boolean;
  destination?: 'stdout' | 'stderr';
}

export function createLogger(options: LoggerOptions): Logger {
  const fd = options.destination === 'stderr' ? 2 : 1;

  const base: pino.LoggerOptions = {
    level: options.level,
    name: options.name,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Never log credentials, even accidentally via object spreads.
    redact: {
      paths: [
        'authorization',
        '*.authorization',
        'headers.authorization',
        'headers["x-api-key"]',
        // Never leak credentials handled by this server: ASC .p8 keys/JWTs,
        // Anthropic keys, issue-tracker tokens.
        'privateKey',
        '*.privateKey',
        'privateKeyPem',
        '*.privateKeyPem',
        'apiKey',
        '*.apiKey',
        'token',
        '*.token',
        'apiToken',
        '*.apiToken',
      ],
      censor: '[REDACTED]',
    },
    // Correlation: merge the AsyncLocalStorage request context into every line.
    mixin: () => ({ ...getRequestContext() }),
  };

  if (options.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { destination: fd, colorize: true, translateTime: 'HH:MM:ss' },
      },
    });
  }

  return pino(base, pino.destination(fd));
}

/** A silent logger for tests. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
