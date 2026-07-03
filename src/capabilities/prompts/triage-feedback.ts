/**
 * triage_feedback — a guided end-to-end workflow prompt: the fastest way for
 * a user to experience the whole pipeline (list → group → prioritize →
 * analyze → todo → issue → processed).
 */
import { z } from 'zod';
import { definePrompt } from '../../core/registry/define.js';

export const triageFeedbackPrompt = definePrompt({
  name: 'triage_feedback',
  title: 'Triage TestFlight feedback',
  description: 'Guided workflow: fetch, deduplicate, prioritize, analyze and act on pending TestFlight feedback.',
  argumentsSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (omit to use ASC_APP_ID)'),
    limit: z.string().optional().describe('How many feedback items to triage (default 25)'),
  }),
  handler: ({ appId, limit }) => ({
    description: 'Triage pending TestFlight feedback end to end',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Triage my pending TestFlight feedback${appId ? ` for app ${appId}` : ''}.`,
            '',
            'Follow this workflow with the TestFlight MCP tools:',
            `1. list_unprocessed (limit ${limit ?? '25'}) to fetch the queue.`,
            '2. group_duplicates to cluster similar reports.',
            '3. prioritize_feedback and pick the top 3 groups.',
            '4. For each representative item: analyze_feedback (inspect the screenshots carefully; if asked, persist your analysis with save_analysis).',
            '5. generate_todo for each analyzed item.',
            '6. Recommend which to fix first and why. If an issue tracker is configured, offer to create_issue.',
            '7. After filing issues, mark the corresponding feedback processed with a note.',
            '',
            'Finish with a concise summary table: group, severity, count, recommendation.',
          ].join('\n'),
        },
      },
    ],
  }),
});
