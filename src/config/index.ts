/**
 * Application configuration.
 *
 * All configuration enters the process through environment variables and is
 * validated by a Zod schema at startup — the process refuses to boot with an
 * invalid configuration (fail fast, not at first request).
 *
 * The raw env schema is transformed into a structured, strongly-typed
 * `AppConfig` object so the rest of the codebase never touches `process.env`.
 *
 * App Store Connect credentials are optional at boot: the server starts and
 * serves local-state tools without them, and ASC-backed tools return an
 * actionable configuration message. Partial ASC configuration is a hard error
 * (misconfiguration should fail loudly, absence should degrade gracefully).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Default state location. A home-directory default (not ./data) because MCP
 * hosts spawn this server inside arbitrary project directories — a relative
 * default would scatter data/ folders across the user's repos.
 */
const DEFAULT_DATA_DIR = join(homedir(), '.mcp-server-appstoreconnect');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Server identity (reported in the MCP `initialize` handshake).
  SERVER_NAME: z.string().min(1).default('mcp-server-appstoreconnect'),
  SERVER_VERSION: z.string().min(1).default('0.1.0'),
  /** Optional human-readable instructions surfaced to MCP clients. */
  MCP_INSTRUCTIONS: z.string().optional(),

  // Transport selection for `src/server.ts` (`--stdio` CLI flag overrides).
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),

  // HTTP transport.
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Comma-separated Origin allowlist (DNS-rebinding protection + CORS). */
  ALLOWED_ORIGINS: z.string().default(''),

  // Logging.
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  // Authentication.
  AUTH_MODE: z.enum(['none', 'api-key', 'jwt']).default('none'),
  /**
   * API keys with optional scopes. Format: `key1:scopeA|scopeB,key2:*,key3`.
   * A key without scopes gets the wildcard scope `*`.
   */
  API_KEYS: z.string().default(''),
  JWT_SECRET: z.string().optional(),
  JWT_JWKS_URL: z.url().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),

  // Rate limiting (HTTP transport only; use API Gateway throttling on Lambda).
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Sessions & requests.
  SESSION_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  /**
   * Stateless mode: every request runs against an ephemeral, pre-initialized
   * session. Required for Lambda / serverless where no memory is shared
   * between invocations. Disables server-push (subscriptions, notifications).
   */
  STATELESS: z.stringbool().default(false),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Observability.
  METRICS_ENABLED: z.stringbool().default(true),

  // --- App Store Connect --------------------------------------------------
  /** Issuer ID from App Store Connect → Users and Access → Integrations. */
  ASC_ISSUER_ID: z.string().optional(),
  /** Key ID of the API key. */
  ASC_KEY_ID: z.string().optional(),
  /** Path to the .p8 private key file (exactly one key source). */
  ASC_PRIVATE_KEY_PATH: z.string().optional(),
  /** Base64-encoded .p8 contents (alternative to the file path). */
  ASC_PRIVATE_KEY_BASE64: z.string().optional(),
  /** Default app id — saves passing appId to every tool call. */
  ASC_APP_ID: z.string().optional(),
  ASC_API_BASE_URL: z.url().default('https://api.appstoreconnect.apple.com'),

  // --- Local state ----------------------------------------------------------
  /** SQLite database path (':memory:' supported; on Lambda use /tmp). */
  STATE_DB_PATH: z.string().default(join(DEFAULT_DATA_DIR, 'testflight.db')),
  /** Directory screenshots are downloaded into. */
  SCREENSHOTS_DIR: z.string().default(join(DEFAULT_DATA_DIR, 'screenshots')),

  // --- AI analysis (optional — host-delegated mode needs no key) ------------
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  // --- Issue providers (each optional; all-or-nothing per provider) --------
  GITHUB_TOKEN: z.string().optional(),
  /** "owner/repo" */
  GITHUB_REPO: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"').optional(),
  JIRA_BASE_URL: z.url().optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_PROJECT_KEY: z.string().optional(),
  JIRA_ISSUE_TYPE: z.string().default('Bug'),
  LINEAR_API_KEY: z.string().optional(),
  LINEAR_TEAM_ID: z.string().optional(),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ApiKeyEntry {
  readonly key: string;
  readonly scopes: readonly string[];
}

export interface AscConfig {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKeyPath?: string;
  readonly privateKeyBase64?: string;
}

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly instructions?: string;
  };
  readonly transport: 'http' | 'stdio';
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimitBytes: number;
    readonly allowedOrigins: readonly string[];
  };
  readonly log: { readonly level: LogLevel; readonly pretty: boolean };
  readonly auth: {
    readonly mode: 'none' | 'api-key' | 'jwt';
    readonly apiKeys: readonly ApiKeyEntry[];
    readonly jwt: {
      readonly secret?: string;
      readonly jwksUrl?: string;
      readonly issuer?: string;
      readonly audience?: string;
    };
  };
  readonly rateLimit: {
    readonly enabled: boolean;
    readonly max: number;
    readonly windowMs: number;
  };
  readonly session: { readonly ttlMs: number; readonly stateless: boolean };
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly metrics: { readonly enabled: boolean };

  /** Undefined until ASC credentials are configured. */
  readonly asc?: AscConfig;
  readonly ascBaseUrl: string;
  /** Default app for feedback tools (tools also accept an explicit appId). */
  readonly defaultAppId?: string;
  readonly paths: { readonly dbPath: string; readonly screenshotsDir: string };
  readonly anthropic: { readonly apiKey?: string; readonly model: string };
  readonly issues: {
    readonly github?: { readonly token: string; readonly repo: string };
    readonly jira?: {
      readonly baseUrl: string;
      readonly email: string;
      readonly apiToken: string;
      readonly projectKey: string;
      readonly issueType: string;
    };
    readonly linear?: { readonly apiKey: string; readonly teamId: string };
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseApiKeys(raw: string): ApiKeyEntry[] {
  return splitCsv(raw).map((entry) => {
    // Split on the FIRST colon only — scopes themselves may contain colons
    // (e.g. `mykey:tools:fetch|resources:read`).
    const separator = entry.indexOf(':');
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const scopesRaw = separator === -1 ? '' : entry.slice(separator + 1);
    const scopes = scopesRaw
      ? scopesRaw.split('|').map((s) => s.trim()).filter(Boolean)
      : ['*'];
    return { key, scopes };
  });
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid configuration:\n${message}`);
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate configuration from an environment object.
 * Throws {@link ConfigError} with a human-readable report on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(z.prettifyError(parsed.error));
  }
  const e = parsed.data;

  // Cross-field invariants that a per-field schema cannot express.
  if (e.AUTH_MODE === 'api-key' && parseApiKeys(e.API_KEYS).length === 0) {
    throw new ConfigError('AUTH_MODE=api-key requires at least one entry in API_KEYS');
  }
  if (e.AUTH_MODE === 'jwt' && !e.JWT_SECRET && !e.JWT_JWKS_URL) {
    throw new ConfigError('AUTH_MODE=jwt requires JWT_SECRET or JWT_JWKS_URL');
  }

  // ASC credentials: all-or-nothing, and exactly one key source.
  const hasKeySource = Boolean(e.ASC_PRIVATE_KEY_PATH ?? e.ASC_PRIVATE_KEY_BASE64);
  const anyAsc = Boolean(e.ASC_ISSUER_ID ?? e.ASC_KEY_ID) || hasKeySource;
  if (anyAsc && !(e.ASC_ISSUER_ID && e.ASC_KEY_ID && hasKeySource)) {
    throw new ConfigError(
      'Partial App Store Connect configuration: ASC_ISSUER_ID, ASC_KEY_ID and one of ' +
        'ASC_PRIVATE_KEY_PATH / ASC_PRIVATE_KEY_BASE64 must all be set together',
    );
  }
  if (e.ASC_PRIVATE_KEY_PATH && e.ASC_PRIVATE_KEY_BASE64) {
    throw new ConfigError(
      'Set only one of ASC_PRIVATE_KEY_PATH and ASC_PRIVATE_KEY_BASE64, not both',
    );
  }

  // Issue providers: all-or-nothing per provider.
  if (Boolean(e.GITHUB_TOKEN) !== Boolean(e.GITHUB_REPO)) {
    throw new ConfigError('GitHub issues require both GITHUB_TOKEN and GITHUB_REPO');
  }
  const jiraFields = [e.JIRA_BASE_URL, e.JIRA_EMAIL, e.JIRA_API_TOKEN, e.JIRA_PROJECT_KEY];
  if (jiraFields.some(Boolean) && !jiraFields.every(Boolean)) {
    throw new ConfigError(
      'Jira issues require JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT_KEY together',
    );
  }
  if (Boolean(e.LINEAR_API_KEY) !== Boolean(e.LINEAR_TEAM_ID)) {
    throw new ConfigError('Linear issues require both LINEAR_API_KEY and LINEAR_TEAM_ID');
  }

  return {
    env: e.NODE_ENV,
    server: {
      name: e.SERVER_NAME,
      version: e.SERVER_VERSION,
      ...(e.MCP_INSTRUCTIONS ? { instructions: e.MCP_INSTRUCTIONS } : {}),
    },
    transport: e.MCP_TRANSPORT,
    http: {
      host: e.HTTP_HOST,
      port: e.HTTP_PORT,
      bodyLimitBytes: e.HTTP_BODY_LIMIT_BYTES,
      allowedOrigins: splitCsv(e.ALLOWED_ORIGINS),
    },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    auth: {
      mode: e.AUTH_MODE,
      apiKeys: parseApiKeys(e.API_KEYS),
      jwt: {
        ...(e.JWT_SECRET ? { secret: e.JWT_SECRET } : {}),
        ...(e.JWT_JWKS_URL ? { jwksUrl: e.JWT_JWKS_URL } : {}),
        ...(e.JWT_ISSUER ? { issuer: e.JWT_ISSUER } : {}),
        ...(e.JWT_AUDIENCE ? { audience: e.JWT_AUDIENCE } : {}),
      },
    },
    rateLimit: {
      enabled: e.RATE_LIMIT_ENABLED,
      max: e.RATE_LIMIT_MAX,
      windowMs: e.RATE_LIMIT_WINDOW_MS,
    },
    session: { ttlMs: e.SESSION_TTL_MS, stateless: e.STATELESS },
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    metrics: { enabled: e.METRICS_ENABLED },

    ...(anyAsc
      ? {
          asc: {
            issuerId: e.ASC_ISSUER_ID!,
            keyId: e.ASC_KEY_ID!,
            ...(e.ASC_PRIVATE_KEY_PATH ? { privateKeyPath: e.ASC_PRIVATE_KEY_PATH } : {}),
            ...(e.ASC_PRIVATE_KEY_BASE64 ? { privateKeyBase64: e.ASC_PRIVATE_KEY_BASE64 } : {}),
          },
        }
      : {}),
    ascBaseUrl: e.ASC_API_BASE_URL,
    ...(e.ASC_APP_ID ? { defaultAppId: e.ASC_APP_ID } : {}),
    paths: { dbPath: e.STATE_DB_PATH, screenshotsDir: e.SCREENSHOTS_DIR },
    anthropic: {
      ...(e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY } : {}),
      model: e.ANTHROPIC_MODEL,
    },
    issues: {
      ...(e.GITHUB_TOKEN && e.GITHUB_REPO
        ? { github: { token: e.GITHUB_TOKEN, repo: e.GITHUB_REPO } }
        : {}),
      ...(e.JIRA_BASE_URL && e.JIRA_EMAIL && e.JIRA_API_TOKEN && e.JIRA_PROJECT_KEY
        ? {
            jira: {
              baseUrl: e.JIRA_BASE_URL,
              email: e.JIRA_EMAIL,
              apiToken: e.JIRA_API_TOKEN,
              projectKey: e.JIRA_PROJECT_KEY,
              issueType: e.JIRA_ISSUE_TYPE,
            },
          }
        : {}),
      ...(e.LINEAR_API_KEY && e.LINEAR_TEAM_ID
        ? { linear: { apiKey: e.LINEAR_API_KEY, teamId: e.LINEAR_TEAM_ID } }
        : {}),
    },
  };
}
