/**
 * Main entry point for long-lived deployments (local dev, Docker, K8s, ECS).
 *
 * Transport selection: `--stdio` CLI flag wins, then MCP_TRANSPORT env.
 *   node dist/server.js            → HTTP (Streamable HTTP + SSE)
 *   node dist/server.js --stdio    → stdio (Claude Desktop, Cursor, ...)
 */
import { buildHttpServer } from './adapters/http.js';
import { createStdioTransport } from './adapters/stdio.js';
import { loadConfig } from './config/index.js';
import { createAppContext } from './core/container.js';
import { registerShutdownHooks } from './utils/graceful-shutdown.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const transport = process.argv.includes('--stdio') ? 'stdio' : config.transport;

  if (transport === 'stdio') {
    // stdout carries the protocol — all logs MUST go to stderr.
    const app = createAppContext({ config, logDestination: 'stderr' });
    const stdio = createStdioTransport(app);
    stdio.start();

    registerShutdownHooks({
      logger: app.logger,
      timeoutMs: config.shutdownTimeoutMs,
      hooks: [
        { name: 'stdio-transport', fn: () => stdio.stop() },
        { name: 'app-context', fn: () => app.dispose() },
      ],
    });
    return;
  }

  const app = createAppContext({ config });
  const server = await buildHttpServer(app);
  const address = await server.listen({
    host: config.http.host,
    port: config.http.port,
  });
  app.logger.info({ address, transport: 'http' }, 'MCP server listening');

  if (config.http.host !== '127.0.0.1' && config.http.allowedOrigins.length === 0) {
    app.logger.warn(
      'server is bound to a non-loopback interface without ALLOWED_ORIGINS — browser clients will be rejected; set ALLOWED_ORIGINS for cross-origin use',
    );
  }

  registerShutdownHooks({
    logger: app.logger,
    timeoutMs: config.shutdownTimeoutMs,
    hooks: [
      { name: 'http-server', fn: () => server.close() },
      { name: 'app-context', fn: () => app.dispose() },
    ],
  });
}

main().catch((err: unknown) => {
  // Logger may not exist yet (e.g. config error) — write directly to stderr.
  console.error('Fatal startup error:', err);
  process.exit(1);
});
