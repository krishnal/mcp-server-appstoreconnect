/**
 * Linear provider — GraphQL `issueCreate` mutation. Linear renders markdown
 * natively, so the body passes through untouched.
 */
import { request } from 'undici';
import { IssueProviderError, type CreatedIssue, type IssuePayload, type IssueProvider } from './types.js';

export interface LinearConfig {
  apiKey: string;
  teamId: string;
  baseUrl?: string;
}

const MUTATION = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { identifier url }
  }
}`;

export class LinearIssueProvider implements IssueProvider {
  readonly name = 'linear';

  constructor(private readonly config: LinearConfig) {}

  async create(payload: IssuePayload, signal?: AbortSignal): Promise<CreatedIssue> {
    const response = await request(this.config.baseUrl ?? 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        // Linear personal API keys are sent bare, not as "Bearer <key>".
        authorization: this.config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: MUTATION,
        variables: {
          input: {
            teamId: this.config.teamId,
            title: payload.title,
            description: payload.bodyMarkdown,
          },
        },
      }),
      signal,
    });

    const body = (await response.body.json().catch(() => ({}))) as {
      data?: { issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } };
      errors?: { message?: string }[];
    };
    const issue = body.data?.issueCreate?.issue;
    if (
      response.statusCode >= 400 ||
      body.errors?.length ||
      !body.data?.issueCreate?.success ||
      !issue?.identifier ||
      !issue.url
    ) {
      const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ');
      throw new IssueProviderError(
        this.name,
        `HTTP ${response.statusCode}${detail ? ` — ${detail}` : ''}`,
      );
    }
    return { key: issue.identifier, url: issue.url };
  }
}
