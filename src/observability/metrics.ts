/**
 * Prometheus metrics (prom-client).
 *
 * A dedicated registry per app context keeps tests isolated and avoids the
 * global-registry pitfalls of prom-client. The HTTP adapter exposes
 * `GET /metrics` when enabled.
 */
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly enabled: boolean;

  /** JSON-RPC requests by method and outcome (`ok` | `error`). */
  readonly rpcRequests: Counter<'method' | 'status'>;
  /** JSON-RPC request latency. */
  readonly rpcDuration: Histogram<'method'>;
  /** Tool invocations by tool name and outcome (`ok` | `error` | `denied`). */
  readonly toolCalls: Counter<'tool' | 'outcome'>;
  /** Live MCP sessions (HTTP transport). */
  readonly activeSessions: Gauge;

  constructor(options: { enabled: boolean; collectDefault?: boolean }) {
    this.enabled = options.enabled;

    this.rpcRequests = new Counter({
      name: 'mcp_rpc_requests_total',
      help: 'Total JSON-RPC requests processed',
      labelNames: ['method', 'status'],
      registers: [this.registry],
    });
    this.rpcDuration = new Histogram({
      name: 'mcp_rpc_request_duration_seconds',
      help: 'JSON-RPC request duration in seconds',
      labelNames: ['method'],
      buckets: [0.005, 0.025, 0.1, 0.25, 1, 2.5, 10],
      registers: [this.registry],
    });
    this.toolCalls = new Counter({
      name: 'mcp_tool_calls_total',
      help: 'Total MCP tool invocations',
      labelNames: ['tool', 'outcome'],
      registers: [this.registry],
    });
    this.activeSessions = new Gauge({
      name: 'mcp_active_sessions',
      help: 'Number of live MCP sessions',
      registers: [this.registry],
    });

    if (options.enabled && options.collectDefault !== false) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
