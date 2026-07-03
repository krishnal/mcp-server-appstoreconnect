/**
 * Issue-tracker integration contract.
 *
 * A provider turns one payload into one issue. Idempotency lives OUTSIDE the
 * providers (the `issues` table keyed on feedback id + provider), so
 * implementations stay a single HTTP call. To add a tracker: implement this
 * interface and register it in `createIssueProviders`.
 */

export interface IssuePayload {
  title: string;
  /** Markdown body. Providers that need another format convert internally. */
  bodyMarkdown: string;
  labels?: string[];
}

export interface CreatedIssue {
  /** Human-readable key/number, e.g. "#42", "PROJ-123", "ENG-42". */
  key: string;
  url: string;
}

export interface IssueProvider {
  readonly name: string;
  create(payload: IssuePayload, signal?: AbortSignal): Promise<CreatedIssue>;
}

export class IssueProviderError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'IssueProviderError';
  }
}
