/**
 * Resource subscription hub.
 *
 * Maps resource URIs to subscribed sessions and fans out
 * `notifications/resources/updated` when business logic reports a change
 * (via `AppContext.notifyResourceUpdated`). In-memory by design: server-push
 * requires a live connection, so this only applies to stdio/HTTP transports.
 */
import type { Session } from './session.js';

export class ResourceSubscriptionHub {
  private readonly byUri = new Map<string, Set<Session>>();

  subscribe(session: Session, uri: string): void {
    let sessions = this.byUri.get(uri);
    if (!sessions) {
      sessions = new Set();
      this.byUri.set(uri, sessions);
    }
    sessions.add(session);
    session.subscriptions.add(uri);
  }

  unsubscribe(session: Session, uri: string): void {
    const sessions = this.byUri.get(uri);
    if (sessions) {
      sessions.delete(session);
      if (sessions.size === 0) this.byUri.delete(uri);
    }
    session.subscriptions.delete(uri);
  }

  /** Remove all subscriptions for a closing/evicted session. */
  dropSession(session: Session): void {
    for (const uri of [...session.subscriptions]) {
      this.unsubscribe(session, uri);
    }
  }

  subscriberCount(uri: string): number {
    return this.byUri.get(uri)?.size ?? 0;
  }

  /** Notify all subscribers that a resource's contents changed. */
  async notifyUpdated(uri: string): Promise<void> {
    const sessions = this.byUri.get(uri);
    if (!sessions) return;
    await Promise.all(
      [...sessions].map((session) =>
        session.send({
          jsonrpc: '2.0',
          method: 'notifications/resources/updated',
          params: { uri },
        }),
      ),
    );
  }
}
