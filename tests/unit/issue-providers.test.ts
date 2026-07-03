import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIssueBody, buildIssueTitle } from '../../src/issues/body.js';
import { GitHubIssueProvider } from '../../src/issues/github.js';
import { JiraIssueProvider } from '../../src/issues/jira.js';
import { LinearIssueProvider } from '../../src/issues/linear.js';
import { IssueProviderError } from '../../src/issues/types.js';
import { feedbackItem } from '../helpers/fixtures.js';

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

const payload = { title: 'Bug', bodyMarkdown: '## details\n\nsomething broke' };

describe('GitHubIssueProvider', () => {
  it('creates an issue and returns key/url', async () => {
    let sent: any;
    agent
      .get('https://api.github.com')
      .intercept({ path: '/repos/me/app/issues', method: 'POST' })
      .reply(201, (opts) => {
        sent = JSON.parse(opts.body as string);
        return { number: 7, html_url: 'https://github.com/me/app/issues/7' };
      });

    const provider = new GitHubIssueProvider({ token: 't', repo: 'me/app' });
    const created = await provider.create({ ...payload, labels: ['bug'] });
    expect(created).toEqual({ key: '#7', url: 'https://github.com/me/app/issues/7' });
    expect(sent).toMatchObject({ title: 'Bug', labels: ['bug'] });
  });

  it('surfaces API errors with the upstream message', async () => {
    agent
      .get('https://api.github.com')
      .intercept({ path: '/repos/me/app/issues', method: 'POST' })
      .reply(422, { message: 'Validation Failed' });

    const provider = new GitHubIssueProvider({ token: 't', repo: 'me/app' });
    const error = await provider.create(payload).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(IssueProviderError);
    expect(String(error)).toMatch(/Validation Failed/);
  });
});

describe('JiraIssueProvider', () => {
  it('creates an issue with an ADF description and returns the browse URL', async () => {
    let sent: any;
    agent
      .get('https://example.atlassian.net')
      .intercept({ path: '/rest/api/3/issue', method: 'POST' })
      .reply(201, (opts) => {
        sent = JSON.parse(opts.body as string);
        return { key: 'PROJ-42' };
      });

    const provider = new JiraIssueProvider({
      baseUrl: 'https://example.atlassian.net',
      email: 'e@x.com',
      apiToken: 't',
      projectKey: 'PROJ',
    });
    const created = await provider.create(payload);
    expect(created).toEqual({ key: 'PROJ-42', url: 'https://example.atlassian.net/browse/PROJ-42' });
    expect(sent.fields.project.key).toBe('PROJ');
    expect(sent.fields.description.type).toBe('doc');
    expect(sent.fields.description.content.length).toBeGreaterThan(0);
  });
});

describe('LinearIssueProvider', () => {
  it('creates an issue via GraphQL', async () => {
    agent
      .get('https://api.linear.app')
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(200, {
        data: { issueCreate: { success: true, issue: { identifier: 'ENG-9', url: 'https://linear.app/x/ENG-9' } } },
      });

    const provider = new LinearIssueProvider({ apiKey: 'k', teamId: 'team' });
    const created = await provider.create(payload);
    expect(created).toEqual({ key: 'ENG-9', url: 'https://linear.app/x/ENG-9' });
  });

  it('treats GraphQL errors as failures', async () => {
    agent
      .get('https://api.linear.app')
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(200, { errors: [{ message: 'team not found' }] });

    const provider = new LinearIssueProvider({ apiKey: 'k', teamId: 'team' });
    await expect(provider.create(payload)).rejects.toThrow(/team not found/);
  });
});

describe('issue body assembly', () => {
  it('bundles analysis, context, screenshots and todo into markdown', () => {
    const input = {
      item: feedbackItem(),
      analysis: {
        summary: 'Checkout overlap',
        problem: 'Button overlaps label',
        severity: 'high' as const,
        confidence: 0.9,
        screen: 'Checkout',
      },
      todoMarkdown: '## TODO — Checkout overlap\n- [ ] Reproduce',
      screenshotPaths: ['./screenshots/fb-1/screenshot-1.png'],
    };

    expect(buildIssueTitle(input)).toBe('[TestFlight] Checkout overlap');
    const body = buildIssueBody(input);
    expect(body).toContain('## AI analysis');
    expect(body).toContain('Severity: high');
    expect(body).toContain('The checkout button overlaps the total price label');
    expect(body).toContain('iPhone17,2');
    expect(body).toContain('screenshot-1.png');
    expect(body).toContain('- [ ] Reproduce');
  });

  it('marks crashes in the title', () => {
    expect(buildIssueTitle({ item: feedbackItem({ kind: 'crash', comment: 'boom' }) })).toBe(
      '[Crash] boom',
    );
  });
});
