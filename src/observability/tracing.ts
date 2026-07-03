/**
 * OpenTelemetry instrumentation hooks.
 *
 * Uses only `@opentelemetry/api` — a tiny, dependency-free package that is a
 * no-op until an OpenTelemetry SDK is registered in the process. To turn on
 * real tracing, install `@opentelemetry/sdk-node` (+ an exporter) and start
 * it before the server boots; every span below lights up automatically.
 * See README → Observability.
 */
import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

const tracer = trace.getTracer('mcp-server');

/**
 * Run `fn` inside an active span. Errors are recorded on the span and
 * re-thrown; the span is always ended.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
