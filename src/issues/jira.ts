/**
 * Jira Cloud provider — REST v3 `POST /rest/api/3/issue` (Basic auth:
 * email + API token). v3 requires the description in Atlassian Document
 * Format; markdown is down-converted to plain paragraphs (v1 tradeoff —
 * links and checklists arrive as text, nothing is lost semantically).
 */
import { request } from 'undici';
import { IssueProviderError, type CreatedIssue, type IssuePayload, type IssueProvider } from './types.js';

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType?: string;
}

export class JiraIssueProvider implements IssueProvider {
  readonly name = 'jira';

  constructor(private readonly config: JiraConfig) {}

  async create(payload: IssuePayload, signal?: AbortSignal): Promise<CreatedIssue> {
    const base = this.config.baseUrl.replace(/\/$/, '');
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');

    const response = await request(`${base}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: this.config.projectKey },
          issuetype: { name: this.config.issueType ?? 'Bug' },
          summary: payload.title,
          labels: (payload.labels ?? []).map((label) => label.replace(/\s+/g, '-')),
          description: markdownToAdf(payload.bodyMarkdown),
        },
      }),
      signal,
    });

    const body = (await response.body.json().catch(() => ({}))) as {
      key?: string;
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    if (response.statusCode >= 400 || !body.key) {
      const detail =
        body.errorMessages?.join('; ') ??
        (body.errors ? Object.values(body.errors).join('; ') : undefined);
      throw new IssueProviderError(
        this.name,
        `HTTP ${response.statusCode}${detail ? ` — ${detail}` : ''}`,
      );
    }
    return { key: body.key, url: `${base}/browse/${body.key}` };
  }
}

/** Minimal markdown → ADF: one paragraph per non-empty line block. */
function markdownToAdf(markdown: string): Record<string, unknown> {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: block }],
    }));
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph', content: [] }],
  };
}
