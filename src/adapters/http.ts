/**
 * HTTP transport — MCP "Streamable HTTP" (spec 2025-06-18) on Fastify.
 *
 *   POST   /mcp   JSON-RPC messages (responses returned as JSON)
 *   GET    /mcp   SSE stream for server→client notifications
 *   DELETE /mcp   explicit session termination
 *   GET    /healthz | /readyz | /metrics   operational endpoints
 *
 * Also provides: auth enforcement (HTTP 401 at the edge), Origin validation
 * (DNS-rebinding protection), CORS, rate limiting, body limits, and
 * request-id propagation into the dispatcher's correlation context.
 */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { AuthError, extractCredentials, type AuthContext } from '../auth/types.js';
import type { AppContext } from '../core/container.js';
import type { JsonRpcNotification } from '../core/jsonrpc/types.js';
import { isSupportedProtocolVersion, LATEST_PROTOCOL_VERSION } from '../core/protocol/versions.js';
import { Session } from '../core/session.js';
import { newRequestId, runWithRequestContext } from '../observability/request-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function buildHttpServer(app: AppContext): Promise<FastifyInstance> {
  const { config, dispatcher, sessions, metrics, authProvider, logger } = app;
  const stateless = config.session.stateless;

  const fastify = Fastify({
    // Erase the concrete pino generic so the instance keeps the default
    // FastifyInstance type (pino.Logger is structurally a FastifyBaseLogger).
    loggerInstance: logger as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: config.http.bodyLimitBytes,
    genReqId: (req) => headerValue(req.headers['x-request-id']) ?? newRequestId(),
  });

  // --- cross-cutting plugins -----------------------------------------------

  if (config.http.allowedOrigins.length > 0) {
    await fastify.register(cors, {
      origin: [...config.http.allowedOrigins],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'content-type',
        'authorization',
        'x-api-key',
        'x-request-id',
        SESSION_HEADER,
        PROTOCOL_VERSION_HEADER,
      ],
      exposedHeaders: [SESSION_HEADER],
    });
  }

  await fastify.register(rateLimit, { global: false });
  const rateLimitRouteConfig = config.rateLimit.enabled
    ? {
        rateLimit: {
          max: config.rateLimit.max,
          timeWindow: config.rateLimit.windowMs,
        },
      }
    : {};

  // --- shared per-request guards -------------------------------------------

  /**
   * Origin validation (DNS-rebinding protection). Non-browser clients send no
   * Origin and pass. Browsers must match the allowlist; with an empty
   * allowlist only localhost origins are accepted.
   */
  function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    if (config.http.allowedOrigins.includes(origin)) return true;
    if (config.http.allowedOrigins.length === 0) {
      try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      } catch {
        return false;
      }
    }
    return false;
  }

  async function guardMcpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    if (!isOriginAllowed(headerValue(request.headers.origin))) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }

    const protocolVersion = headerValue(request.headers[PROTOCOL_VERSION_HEADER]);
    if (protocolVersion && !isSupportedProtocolVersion(protocolVersion)) {
      return reply.code(400).send({ error: `Unsupported MCP protocol version: ${protocolVersion}` });
    }

    try {
      request.authContext = await authProvider.authenticate(extractCredentials(request.headers));
    } catch (err) {
      if (err instanceof AuthError) {
        return reply
          .code(err.statusCode)
          .header('WWW-Authenticate', 'Bearer')
          .send({ error: err.message });
      }
      throw err;
    }
    return undefined;
  }

  /** Resolve the session for a non-initialize message. */
  function resolveSession(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthContext,
  ): Session | FastifyReply {
    if (stateless) {
      return Session.ephemeral(auth, LATEST_PROTOCOL_VERSION);
    }
    const sessionId = headerValue(request.headers[SESSION_HEADER]);
    if (!sessionId) {
      return reply.code(400).send({ error: `Missing ${SESSION_HEADER} header` });
    }
    const session = sessions.get(sessionId);
    if (!session || session.state === 'closed') {
      // Per spec: 404 tells the client to start a fresh initialize handshake.
      return reply.code(404).send({ error: 'Session not found or expired' });
    }
    // Bind sessions to the principal that created them.
    if (session.auth.subject !== auth.subject) {
      return reply.code(401).send({ error: 'Session does not belong to this principal' });
    }
    return session;
  }

  // Track SSE cleanups so graceful shutdown can sever streams promptly.
  const sseCleanups = new Set<() => void>();
  fastify.addHook('onClose', async () => {
    for (const cleanup of sseCleanups) cleanup();
    sseCleanups.clear();
  });

  // --- MCP endpoint ----------------------------------------------------------

  fastify.post(
    '/mcp',
    { preHandler: guardMcpRequest, config: rateLimitRouteConfig },
    async (request, reply) => {
      const auth = request.authContext!;
      const body: unknown = request.body;

      if (Array.isArray(body)) {
        // JSON-RPC batching was removed in MCP 2025-06-18.
        return reply.code(400).send({ error: 'JSON-RPC batching is not supported' });
      }

      const isInitialize =
        typeof body === 'object' &&
        body !== null &&
        (body as { method?: unknown }).method === 'initialize';

      let session: Session;
      if (isInitialize) {
        session = stateless ? new Session(auth) : sessions.create(auth);
        metrics.activeSessions.set(sessions.size);
      } else {
        const resolved = resolveSession(request, reply, auth);
        if (!(resolved instanceof Session)) return resolved;
        session = resolved;
      }

      const response = await runWithRequestContext(
        { requestId: String(request.id), sessionId: session.id },
        () => dispatcher.handleMessage(body, session),
      );

      if (isInitialize && !stateless) {
        reply.header(SESSION_HEADER, session.id);
      }
      if (response === null) {
        return reply.code(202).send();
      }
      return reply.code(200).send(response);
    },
  );

  fastify.get('/mcp', { preHandler: guardMcpRequest }, async (request, reply) => {
    if (stateless) {
      return reply
        .code(405)
        .send({ error: 'Server is running stateless: no server-push channel available' });
    }
    const resolved = resolveSession(request, reply, request.authContext!);
    if (!(resolved instanceof Session)) return resolved;
    const session = resolved;

    const accept = headerValue(request.headers.accept) ?? '';
    if (!accept.includes('text/event-stream') && !accept.includes('*/*')) {
      return reply.code(406).send({ error: 'Accept must include text/event-stream' });
    }
    if (session.hasSender) {
      return reply.code(409).send({ error: 'An SSE stream is already open for this session' });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write(': connected\n\n');

    const send = (notification: JsonRpcNotification): void => {
      raw.write(`event: message\ndata: ${JSON.stringify(notification)}\n\n`);
    };
    session.setSender(send, logger);

    const heartbeat = setInterval(() => {
      raw.write(': keepalive\n\n');
      session.touch();
    }, 15_000);
    heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      session.setSender(undefined);
    };
    request.raw.on('close', cleanup);
    sseCleanups.add(cleanup);
    request.raw.on('close', () => sseCleanups.delete(cleanup));
    return undefined;
  });

  fastify.delete('/mcp', { preHandler: guardMcpRequest }, async (request, reply) => {
    if (stateless) {
      return reply.code(405).send({ error: 'Stateless server: no sessions to terminate' });
    }
    const sessionId = headerValue(request.headers[SESSION_HEADER]);
    if (!sessionId || !sessions.delete(sessionId)) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    metrics.activeSessions.set(sessions.size);
    return reply.code(200).send({ ok: true });
  });

  // --- operational endpoints --------------------------------------------------

  fastify.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  // Readiness: extend with real dependency checks (DB pings, downstream
  // health) as your business logic grows.
  fastify.get('/readyz', async () => ({ status: 'ok' }));

  if (config.metrics.enabled) {
    fastify.get('/metrics', async (_request, reply) => {
      reply.type(metrics.contentType);
      return metrics.render();
    });
  }

  return fastify;
}
