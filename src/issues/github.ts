/**
 * GitHub Issues provider — REST v3 `POST /repos/{owner}/{repo}/issues`.
 */
import { request } from 'undici';
import { IssueProviderError, type CreatedIssue, type IssuePayload, type IssueProvider } from './types.js';

export interface GitHubConfig {
  token: string;
  /** "owner/repo" */
  repo: string;
  baseUrl?: string;
}

export class GitHubIssueProvider implements IssueProvider {
  readonly name = 'github';

  constructor(private readonly config: GitHubConfig) {}

  async create(payload: IssuePayload, signal?: AbortSignal): Promise<CreatedIssue> {
    const base = (this.config.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    const response = await request(`${base}/repos/${this.config.repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'testflight-mcp-server',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        title: payload.title,
        body: payload.bodyMarkdown,
        labels: payload.labels ?? [],
      }),
      signal,
    });

    const body = (await response.body.json().catch(() => ({}))) as {
      number?: number;
      html_url?: string;
      message?: string;
    };
    if (response.statusCode >= 400 || body.number === undefined || !body.html_url) {
      throw new IssueProviderError(
        this.name,
        `HTTP ${response.statusCode}${body.message ? ` — ${body.message}` : ''}`,
      );
    }
    return { key: `#${body.number}`, url: body.html_url };
  }
}
