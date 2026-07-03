/**
 * Domain services — the one deliberate extension to the boilerplate core.
 *
 * Built once in the composition root and exposed to every capability handler
 * as `ctx.services`, so handlers stay pure `(input, ctx) → result` functions
 * and tests swap in fakes via `CreateAppContextOptions.services`.
 *
 * The ASC client is absent (not half-configured) when credentials are
 * missing; tools convert that absence into an actionable message the calling
 * LLM can relay to the user.
 */
import { AscClient } from '../asc/client.js';
import { AscTokenProvider, resolvePrivateKeyPem } from '../asc/token-provider.js';
import { FeedbackAnalyzer } from '../analysis/analyzer.js';
import type { AppConfig } from '../config/index.js';
import { createIssueProviders } from '../issues/index.js';
import type { IssueProvider } from '../issues/types.js';
import type { Logger } from '../observability/logger.js';
import { FeedbackStore } from '../storage/feedback-store.js';

export interface Services {
  readonly store: FeedbackStore;
  /** Undefined until App Store Connect credentials are configured. */
  readonly asc: AscClient | undefined;
  readonly analyzer: FeedbackAnalyzer;
  readonly issueProviders: ReadonlyMap<string, IssueProvider>;
  dispose(): void;
}

export function createServices(config: AppConfig, logger: Logger): Services {
  const store = new FeedbackStore(config.paths.dbPath);

  const asc = config.asc
    ? new AscClient({
        baseUrl: config.ascBaseUrl,
        tokenProvider: new LazyTokenProvider(config.asc),
        logger,
      })
    : undefined;

  const analyzer = new FeedbackAnalyzer({
    apiKey: config.anthropic.apiKey,
    model: config.anthropic.model,
    logger,
  });

  return {
    store,
    asc,
    analyzer,
    issueProviders: createIssueProviders(config),
    dispose: () => store.close(),
  };
}

/**
 * Token provider that resolves the .p8 key on first use so a missing or
 * malformed key file fails at the first ASC call (as a readable tool error)
 * rather than crashing the boot of an otherwise useful server.
 */
class LazyTokenProvider extends AscTokenProvider {
  private inner: AscTokenProvider | undefined;

  constructor(
    private readonly source: {
      issuerId: string;
      keyId: string;
      privateKeyPath?: string;
      privateKeyBase64?: string;
    },
  ) {
    super({ issuerId: source.issuerId, keyId: source.keyId, privateKeyPem: '' });
  }

  override async getToken(): Promise<string> {
    if (!this.inner) {
      const privateKeyPem = await resolvePrivateKeyPem(this.source);
      this.inner = new AscTokenProvider({
        issuerId: this.source.issuerId,
        keyId: this.source.keyId,
        privateKeyPem,
      });
    }
    return this.inner.getToken();
  }

  override invalidate(): void {
    this.inner?.invalidate();
  }
}
