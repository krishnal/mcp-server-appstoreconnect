/**
 * AWS Lambda adapter — API Gateway (HTTP API v2) / Lambda Function URLs.
 *
 * The same dispatcher and capability handlers run unchanged; only the
 * envelope differs. Lambda is inherently stateless, so every invocation uses
 * an ephemeral, pre-initialized session:
 *   - `initialize` still works (clients handshake normally),
 *   - other requests don't require a prior handshake,
 *   - server-push (SSE, subscriptions) is unavailable — use the container
 *     deployment when you need it.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context as LambdaContext,
} from 'aws-lambda';
import { AuthError, extractCredentials, type AuthContext } from '../auth/types.js';
import type { AppContext } from '../core/container.js';
import { parseJsonRpc } from '../core/jsonrpc/parse.js';
import { LATEST_PROTOCOL_VERSION } from '../core/protocol/versions.js';
import { Session } from '../core/session.js';
import { runWithRequestContext } from '../observability/request-context.js';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function jsonResult(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export type LambdaHandler = (
  event: APIGatewayProxyEventV2,
  context: LambdaContext,
) => Promise<APIGatewayProxyResultV2>;

export function createLambdaHandler(app: AppContext): LambdaHandler {
  const { dispatcher, authProvider, logger } = app;

  return async (event, lambdaContext) => {
    const method = event.requestContext.http.method.toUpperCase();

    if (method === 'OPTIONS') {
      // CORS preflight is best handled by API Gateway config; this is a
      // safety net for Function URLs without CORS configured.
      return { statusCode: 204 };
    }
    if (method !== 'POST') {
      return jsonResult(405, { error: 'Only POST is supported on this deployment' });
    }

    // Authentication (same provider chain as every other transport).
    let auth: AuthContext;
    try {
      auth = await authProvider.authenticate(extractCredentials(event.headers ?? {}));
    } catch (err) {
      if (err instanceof AuthError) {
        return jsonResult(err.statusCode, { error: err.message });
      }
      throw err;
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    const parsed = parseJsonRpc(rawBody);
    if (!parsed.ok) {
      return jsonResult(400, parsed.response);
    }
    if (Array.isArray(parsed.value)) {
      return jsonResult(400, { error: 'JSON-RPC batching is not supported' });
    }

    // `initialize` needs a fresh session so the handshake handler runs; all
    // other messages run against a pre-initialized ephemeral session.
    const isInitialize =
      typeof parsed.value === 'object' &&
      parsed.value !== null &&
      (parsed.value as { method?: unknown }).method === 'initialize';
    const session = isInitialize
      ? new Session(auth)
      : Session.ephemeral(auth, LATEST_PROTOCOL_VERSION);

    try {
      const response = await runWithRequestContext(
        { requestId: lambdaContext.awsRequestId, sessionId: session.id },
        () => dispatcher.handleMessage(parsed.value, session),
      );
      if (response === null) {
        return { statusCode: 202 };
      }
      return jsonResult(200, response);
    } catch (err) {
      // The dispatcher maps handler errors itself; reaching here means an
      // adapter-level bug. Log fully, respond generically.
      logger.error({ err }, 'unhandled error in lambda adapter');
      return jsonResult(500, { error: 'Internal server error' });
    }
  };
}
