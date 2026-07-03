/**
 * The JSON-RPC dispatcher — the transport-agnostic heart of the server.
 *
 * Transports hand it (parsed message, session); it returns a response or
 * `null` (notifications, cancelled requests). All cross-cutting concerns are
 * centralized here so method/capability handlers stay pure:
 *
 *   - structural validation & classification
 *   - lifecycle gating (initialize handshake)
 *   - Zod params validation → -32602 with issue details
 *   - request timeouts and client cancellation (`notifications/cancelled`)
 *   - correlation-id propagation, metrics, OpenTelemetry spans
 *   - error mapping that never leaks internals
 */
import { AuthError } from '../auth/types.js';
import {
  getRequestContext,
  newRequestId,
  runWithRequestContext,
} from '../observability/request-context.js';
import { withSpan } from '../observability/tracing.js';
import { JsonRpcError, JsonRpcErrorCodes, McpErrorCodes } from './jsonrpc/errors.js';
import {
  classifyMessage,
  errorResponse,
  successResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
} from './jsonrpc/types.js';
import type { MethodDependencies, MethodRegistry } from './methods/types.js';
import type { Session } from './session.js';

type AbortReason = 'cancelled' | 'timeout';

function extractProgressToken(params: unknown): string | number | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

export class Dispatcher {
  /** In-flight requests, keyed by `${sessionId}:${requestId}`, for cancellation. */
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly methods: MethodRegistry,
    private readonly deps: MethodDependencies,
  ) {}

  /**
   * Process one raw (already JSON-parsed) message for a session.
   * Returns the response to send back, or `null` when none is due.
   */
  async handleMessage(raw: unknown, session: Session): Promise<JsonRpcResponse | null> {
    const classified = classifyMessage(raw);
    session.touch();

    switch (classified.type) {
      case 'invalid':
        return errorResponse(classified.id, {
          code: JsonRpcErrorCodes.InvalidRequest,
          message: `Invalid request: ${classified.reason}`,
        });
      case 'response':
        // Client responses to server-initiated requests (sampling/elicitation)
        // — not used by this server; ignore quietly.
        this.deps.logger.debug({ sessionId: session.id }, 'ignoring client response message');
        return null;
      case 'notification':
        await this.handleNotification(classified.message, session);
        return null;
      case 'request':
        return this.handleRequest(classified.message, session);
    }
  }

  private async handleNotification(
    notification: JsonRpcNotification,
    session: Session,
  ): Promise<void> {
    // Cancellation is dispatcher-owned: it targets the in-flight map.
    if (notification.method === 'notifications/cancelled') {
      const params = notification.params as { requestId?: RequestId; reason?: string } | undefined;
      if (params?.requestId !== undefined) {
        this.cancel(session, params.requestId, params.reason);
      }
      return;
    }

    const definition = this.methods.get(notification.method);
    if (!definition) {
      // Per JSON-RPC, notifications never get replies — including errors.
      this.deps.logger.debug({ method: notification.method }, 'ignoring unknown notification');
      return;
    }

    return runWithRequestContext(
      { requestId: newRequestId(), sessionId: session.id, method: notification.method },
      async () => {
        try {
          let params: unknown = notification.params;
          if (definition.paramsSchema) {
            const parsed = definition.paramsSchema.safeParse(notification.params);
            if (!parsed.success) return; // invalid notification params: drop
            params = parsed.data;
          }
          await definition.handler(params, {
            ...this.deps,
            session,
            signal: new AbortController().signal,
          });
        } catch (err) {
          this.deps.logger.warn(
            { err, method: notification.method },
            'notification handler failed',
          );
        }
      },
    );
  }

  private async handleRequest(
    request: JsonRpcRequest,
    session: Session,
  ): Promise<JsonRpcResponse | null> {
    // Reuse the transport's correlation id (HTTP x-request-id, Lambda request
    // id) when one is already in scope; otherwise mint one.
    const correlationId = getRequestContext()?.requestId ?? newRequestId();
    return runWithRequestContext(
      { requestId: correlationId, sessionId: session.id, method: request.method },
      () => this.processRequest(request, session, correlationId),
    );
  }

  private async processRequest(
    request: JsonRpcRequest,
    session: Session,
    correlationId: string,
  ): Promise<JsonRpcResponse | null> {
    const { logger, metrics, config } = this.deps;
    const stopTimer = metrics.rpcDuration.startTimer({ method: request.method });

    const definition = this.methods.get(request.method);
    if (!definition) {
      metrics.rpcRequests.inc({ method: request.method, status: 'error' });
      stopTimer();
      return errorResponse(request.id, JsonRpcError.methodNotFound(request.method).toErrorObject());
    }

    // Lifecycle gate: everything except initialize/ping requires a session
    // that has at least received `initialize` (stateless sessions are
    // pre-marked ready).
    if (!definition.allowBeforeInitialization && session.state === 'new') {
      metrics.rpcRequests.inc({ method: request.method, status: 'error' });
      stopTimer();
      return errorResponse(request.id, JsonRpcError.notInitialized().toErrorObject());
    }

    // Cancellation + timeout share one AbortController.
    const controller = new AbortController();
    const inflightKey = `${session.id}:${String(request.id)}`;
    this.inflight.set(inflightKey, controller);
    const timeout = setTimeout(
      () => controller.abort('timeout' satisfies AbortReason),
      config.requestTimeoutMs,
    );

    try {
      return await withSpan(
        `mcp.rpc ${request.method}`,
        { 'rpc.system': 'jsonrpc', 'rpc.method': request.method, 'mcp.session.id': session.id },
        async () => {
          let params: unknown = request.params;
          if (definition.paramsSchema) {
            const parsed = definition.paramsSchema.safeParse(request.params);
            if (!parsed.success) {
              metrics.rpcRequests.inc({ method: request.method, status: 'error' });
              return errorResponse(
                request.id,
                JsonRpcError.fromZodError(parsed.error).toErrorObject(),
              );
            }
            params = parsed.data;
          }

          const progressToken = extractProgressToken(request.params);
          const handlerPromise = Promise.resolve(
            definition.handler(params, {
              ...this.deps,
              session,
              requestId: request.id,
              ...(progressToken !== undefined ? { progressToken } : {}),
              signal: controller.signal,
            }),
          );

          // Even if a handler ignores its signal, the server stops waiting.
          const result = await Promise.race([
            handlerPromise,
            abortedPromise(controller.signal),
          ]);

          metrics.rpcRequests.inc({ method: request.method, status: 'ok' });
          return successResponse(request.id, result ?? {});
        },
      );
    } catch (err) {
      metrics.rpcRequests.inc({ method: request.method, status: 'error' });

      if (err instanceof AbortedError) {
        if (err.reason === 'cancelled') {
          // Spec: a cancelled request MUST NOT receive a response.
          logger.info({ method: request.method, id: request.id }, 'request cancelled by client');
          return null;
        }
        logger.warn({ method: request.method, id: request.id }, 'request timed out');
        return errorResponse(request.id, {
          code: JsonRpcErrorCodes.InternalError,
          message: `Request timed out after ${config.requestTimeoutMs}ms`,
        });
      }
      if (err instanceof JsonRpcError) {
        return errorResponse(request.id, err.toErrorObject());
      }
      if (err instanceof AuthError) {
        return errorResponse(request.id, {
          code: McpErrorCodes.Unauthorized,
          message: err.message,
        });
      }

      // Unknown failure: full details to the log, only a correlation id to
      // the client.
      logger.error({ err, method: request.method }, 'unhandled error in method handler');
      return errorResponse(request.id, JsonRpcError.internal(correlationId).toErrorObject());
    } finally {
      clearTimeout(timeout);
      this.inflight.delete(inflightKey);
      stopTimer();
    }
  }

  /** Abort an in-flight request (from `notifications/cancelled`). */
  cancel(session: Session, requestId: RequestId, reason?: string): void {
    const controller = this.inflight.get(`${session.id}:${String(requestId)}`);
    if (controller) {
      this.deps.logger.debug({ requestId, reason }, 'cancelling in-flight request');
      controller.abort('cancelled' satisfies AbortReason);
    }
  }

  get inflightCount(): number {
    return this.inflight.size;
  }
}

class AbortedError extends Error {
  constructor(readonly reason: AbortReason) {
    super(`Request aborted: ${reason}`);
    this.name = 'AbortedError';
  }
}

function abortedPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () =>
      reject(new AbortedError((signal.reason as AbortReason) ?? 'cancelled'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
