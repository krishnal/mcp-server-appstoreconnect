/**
 * Declarative JSON-RPC method registry.
 *
 * Every MCP method (and any future protocol method) is a `MethodDefinition`:
 * name + optional Zod params schema + handler. The dispatcher owns all
 * cross-cutting behavior — validation, lifecycle gating, timeouts,
 * cancellation, metrics, tracing — so adding a method is pure business logic.
 */
import type { z } from 'zod';
import type { AppConfig } from '../../config/index.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { Services } from '../../services/index.js';
import type { RequestId } from '../jsonrpc/types.js';
import type { CapabilityRegistry } from '../registry/capability-registry.js';
import type { Session } from '../session.js';
import type { ResourceSubscriptionHub } from '../subscriptions.js';

/** Static dependencies shared by all method handlers. */
export interface MethodDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly registry: CapabilityRegistry;
  readonly subscriptions: ResourceSubscriptionHub;
  readonly services: Services;
}

/** Per-invocation context handed to a method handler. */
export interface MethodContext extends MethodDependencies {
  readonly session: Session;
  /** Undefined for notifications. */
  readonly requestId?: RequestId;
  /** Progress token extracted from `params._meta.progressToken`, if any. */
  readonly progressToken?: string | number;
  /** Aborted on cancellation or timeout. */
  readonly signal: AbortSignal;
}

export interface MethodDefinition<Params = unknown, Result = unknown> {
  method: string;
  /**
   * Zod schema for `params`. Use `z.looseObject` so spec-level extras like
   * `_meta` pass through. Omit for methods without params (e.g. `ping`).
   */
  paramsSchema?: z.ZodType<Params>;
  /** Allow before the initialize handshake (only `initialize` and `ping`). */
  allowBeforeInitialization?: boolean;
  handler: (params: Params, ctx: MethodContext) => Result | Promise<Result>;
}

export class MethodRegistry {
  private readonly methods = new Map<string, MethodDefinition>();

  register<P, R>(definition: MethodDefinition<P, R>): this {
    if (this.methods.has(definition.method)) {
      throw new Error(`Method already registered: ${definition.method}`);
    }
    this.methods.set(definition.method, definition as MethodDefinition);
    return this;
  }

  get(method: string): MethodDefinition | undefined {
    return this.methods.get(method);
  }

  list(): string[] {
    return [...this.methods.keys()];
  }
}
