/**
 * stdio transport — newline-delimited JSON-RPC over stdin/stdout.
 *
 * Used by local MCP hosts (Claude Desktop, Cursor, ...). One process ==
 * one client == one session. stdout is the PROTOCOL channel: the composition
 * root must have been created with `logDestination: 'stderr'`.
 *
 * Streams are injectable for tests (pipe fake stdin/stdout through it).
 */
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ANONYMOUS_FULL_ACCESS } from '../auth/types.js';
import type { AppContext } from '../core/container.js';
import { parseJsonRpc } from '../core/jsonrpc/parse.js';
import type { JsonRpcMessage } from '../core/jsonrpc/types.js';
import type { Session } from '../core/session.js';

export interface StdioTransportOptions {
  input?: Readable;
  output?: Writable;
}

export interface StdioTransport {
  start(): void;
  stop(): Promise<void>;
  readonly session: Session;
}

export function createStdioTransport(
  app: AppContext,
  options: StdioTransportOptions = {},
): StdioTransport {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const { logger, dispatcher } = app;

  // The stdio client is the process owner — treated as fully trusted. Use
  // HTTP + auth for anything crossing a trust boundary.
  const session = app.sessions.create(ANONYMOUS_FULL_ACCESS);

  // Serialize writes: concurrent async handlers must not interleave lines.
  let writeChain: Promise<void> = Promise.resolve();
  const writeMessage = (message: JsonRpcMessage): Promise<void> => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          output.write(JSON.stringify(message) + '\n', (err) =>
            err ? reject(err) : resolve(),
          );
        }),
    );
    return writeChain;
  };

  session.setSender((notification) => writeMessage(notification), logger);

  let rl: readline.Interface | undefined;

  return {
    session,

    start(): void {
      rl = readline.createInterface({ input, crlfDelay: Infinity });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        const parsed = parseJsonRpc(trimmed);
        if (!parsed.ok) {
          void writeMessage(parsed.response);
          return;
        }

        void dispatcher
          .handleMessage(parsed.value, session)
          .then((response) => (response ? writeMessage(response) : undefined))
          .catch((err: unknown) => {
            // The dispatcher maps all errors internally; this is a last-resort
            // guard so a transport bug can never kill the process silently.
            logger.error({ err }, 'unexpected stdio dispatch failure');
          });
      });

      rl.on('close', () => {
        logger.info('stdin closed, shutting down stdio transport');
        session.close();
      });

      logger.info('stdio transport ready');
    },

    async stop(): Promise<void> {
      rl?.close();
      session.close();
      app.sessions.delete(session.id);
      await writeChain.catch(() => undefined); // flush pending writes
    },
  };
}
