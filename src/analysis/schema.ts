/**
 * The structured-analysis contract.
 *
 * One schema, two producers: the server-side Claude call (analyze_feedback in
 * autonomous mode) and the MCP host model (save_analysis in host-delegated
 * mode) both persist exactly this shape, so downstream consumers
 * (prioritize_feedback, generate_todo, create_issue) never care who did the
 * vision work.
 */
import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const analysisSchema = z.object({
  summary: z.string().describe('One-sentence summary of the issue'),
  screen: z
    .string()
    .optional()
    .describe('Affected screen or feature visible in the screenshot (e.g. "Checkout — payment sheet")'),
  problem: z.string().describe('What is wrong, as observed from the screenshot(s) and comment'),
  suspectedComponent: z
    .string()
    .optional()
    .describe('Suspected UI component / module / view likely responsible'),
  severity: z.enum(SEVERITIES).describe('Impact severity'),
  confidence: z.number().describe('Confidence in this analysis, 0.0 to 1.0'),
  suggestedFix: z.string().optional().describe('Suggested approach to fix the issue'),
});

export type FeedbackAnalysis = z.output<typeof analysisSchema>;
