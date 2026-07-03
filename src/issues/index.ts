/**
 * Provider registry — only fully-configured providers are offered.
 * `create_issue` lists `providers.keys()` in its error message, so a
 * misconfigured tracker is discoverable rather than a runtime surprise.
 */
import type { AppConfig } from '../config/index.js';
import { GitHubIssueProvider } from './github.js';
import { JiraIssueProvider } from './jira.js';
import { LinearIssueProvider } from './linear.js';
import type { IssueProvider } from './types.js';

export function createIssueProviders(config: AppConfig): Map<string, IssueProvider> {
  const providers = new Map<string, IssueProvider>();
  const issues = config.issues;

  if (issues.github) {
    providers.set('github', new GitHubIssueProvider(issues.github));
  }
  if (issues.jira) {
    providers.set('jira', new JiraIssueProvider(issues.jira));
  }
  if (issues.linear) {
    providers.set('linear', new LinearIssueProvider(issues.linear));
  }
  return providers;
}

export type { CreatedIssue, IssuePayload, IssueProvider } from './types.js';
export { buildIssueBody, buildIssueTitle, type IssueBodyInput } from './body.js';
