/**
 * MCP sessions.
 *
 * A `Session` tracks one client's lifecycle state, negotiated protocol
 * version, auth context and server→client notification channel. Transports
 * own the channel: they call `setSender` when a push medium exists (stdout
 * for stdio, an SSE stream for HTTP). Without a sender, notifications are
 * dropped with a debug log — correct for stateless/Lambda deployments.
 *
 * `SessionStore` is an interface so distributed deployments can swap in a
 * shared store (Redis/DynamoDB) without touching the core.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/types.js';
import type { Logger } from '../observability/logger.js';
import type { JsonRpcNotification } from './jsonrpc/types.js';
import type {
  ClientCapabilities,
  Implementation,
  LoggingLevel,
} from './protocol/types.js';
import type { SessionInfo } from './registry/define.js';

export type SessionState = 'new' | 'initializing' | 'ready' | 'closed';

export type NotificationSender = (notification: JsonRpcNotification) => void | Promise<void>;

export class Session {
  readonly id: string;
  readonly auth: AuthContext;
  state: SessionState = 'new';
  protocolVersion?: string;
  clientInfo?: Implementation;
  clientCapabilities?: ClientCapabilities;
  /** Minimum level for `notifications/message`; unset until `logging/setLevel`. */
  loggingLevel?: LoggingLevel;
  readonly subscriptions = new Set<string>();
  lastActivityAt: number = Date.now();

  private sender?: NotificationSender;
  private logger?: Logger;

  constructor(auth: AuthContext, id: string = randomUUID()) {
    this.auth = auth;
    this.id = id;
  }

  /** Ephemeral, pre-initialized session for stateless (Lambda) dispatch. */
  static ephemeral(auth: AuthContext, protocolVersion: string): Session {
    const session = new Session(auth);
    session.state = 'ready';
    session.protocolVersion = protocolVersion;
    return session;
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      ...(this.protocolVersion ? { protocolVersion: this.protocolVersion } : {}),
      ...(this.clientInfo ? { clientInfo: this.clientInfo } : {}),
    };
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  setSender(sender: NotificationSender | undefined, logger?: Logger): void {
    this.sender = sender;
    if (logger) this.logger = logger;
  }

  get hasSender(): boolean {
    return this.sender !== undefined;
  }

  async send(notification: JsonRpcNotification): Promise<void> {
    if (this.state === 'closed') return;
    if (!this.sender) {
      this.logger?.debug(
        { sessionId: this.id, method: notification.method },
        'dropping notification: session has no push channel',
      );
      return;
    }
    try {
      await this.sender(notification);
    } catch (err) {
      this.logger?.warn({ err, sessionId: this.id }, 'failed to deliver notification');
    }
  }

  close(): void {
    this.state = 'closed';
    this.sender = undefined;
    this.subscriptions.clear();
  }
}

export interface SessionStore {
  create(auth: AuthContext): Session;
  get(id: string): Session | undefined;
  delete(id: string): boolean;
  forEach(fn: (session: Session) => void): void;
  readonly size: number;
  /** Stop background work (TTL sweeps). Idempotent. */
  dispose(): void;
}

export interface InMemorySessionStoreOptions {
  ttlMs: number;
  /** Called when a session is evicted or deleted (for subscription cleanup). */
  onRemove?: (session: Session) => void;
  sweepIntervalMs?: number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: InMemorySessionStoreOptions) {
    const interval = options.sweepIntervalMs ?? Math.min(options.ttlMs, 60_000);
    this.sweeper = setInterval(() => this.sweep(), interval);
    // Never keep the process alive just to expire sessions.
    this.sweeper.unref();
  }

  create(auth: AuthContext): Session {
    const session = new Session(auth);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.lastActivityAt > this.options.ttlMs) {
      this.remove(session);
      return undefined;
    }
    return session;
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.remove(session);
    return true;
  }

  forEach(fn: (session: Session) => void): void {
    for (const session of this.sessions.values()) fn(session);
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.forEach((s) => s.close());
    this.sessions.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt > this.options.ttlMs) {
        this.remove(session);
      }
    }
  }

  private remove(session: Session): void {
    this.sessions.delete(session.id);
    session.close();
    this.options.onRemove?.(session);
  }
}
