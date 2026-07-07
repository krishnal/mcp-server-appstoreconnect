/**
 * Issue body assembly — everything a developer needs to act without opening
 * App Store Connect: comment, build/device context, AI analysis, TODO
 * checklist, and local screenshot paths.
 */
import type { FeedbackItem } from '../asc/types.js';
import type { FeedbackAnalysis } from '../analysis/schema.js';

export interface IssueBodyInput {
  item: FeedbackItem;
  analysis?: FeedbackAnalysis;
  todoMarkdown?: string;
  screenshotPaths?: string[];
}

export function buildIssueTitle(input: IssueBodyInput): string {
  const base =
    input.analysis?.summary ??
    input.item.comment?.split('\n')[0] ??
    `TestFlight ${input.item.kind} feedback`;
  const prefix = input.item.kind === 'crash' ? '[Crash] ' : '[TestFlight] ';
  return `${prefix}${base}`.slice(0, 200);
}

export function buildIssueBody(input: IssueBodyInput): string {
  const { item, analysis } = input;
  const sections: string[] = [];

  if (analysis) {
    sections.push(
      '## AI analysis',
      '',
      `**${analysis.summary}**`,
      '',
      `- Severity: ${analysis.severity} (confidence ${Math.round(analysis.confidence * 100)}%)`,
      ...(analysis.screen ? [`- Affected screen: ${analysis.screen}`] : []),
      ...(analysis.suspectedComponent ? [`- Suspected component: ${analysis.suspectedComponent}`] : []),
      `- Problem: ${analysis.problem}`,
      ...(analysis.suggestedFix ? [`- Suggested fix: ${analysis.suggestedFix}`] : []),
      '',
    );
  }

  sections.push('## Tester feedback', '');
  sections.push(item.comment ? item.comment : '_No comment provided._', '');

  sections.push(
    '## Context',
    '',
    `- Feedback ID: \`${item.id}\` (${item.kind})`,
    `- Submitted: ${item.createdDate}`,
    ...(item.buildNumber ? [`- Build: ${item.buildNumber}`] : []),
    ...(item.bundleId ? [`- Bundle: ${item.bundleId}`] : []),
    ...(item.device.model
      ? [`- Device: ${item.device.model}, ${item.device.platform ?? 'OS'} ${item.device.osVersion ?? '?'}`]
      : []),
    ...(item.device.locale ? [`- Locale: ${item.device.locale}`] : []),
    '',
  );

  if (input.screenshotPaths && input.screenshotPaths.length > 0) {
    sections.push(
      '## Screenshots (local paths)',
      '',
      ...input.screenshotPaths.map((path) => `- \`${path}\``),
      '',
    );
  }

  if (input.todoMarkdown) {
    sections.push(input.todoMarkdown, '');
  }

  sections.push('---', '_Filed automatically from TestFlight feedback via mcp-server-appstoreconnect._');
  return sections.join('\n');
}
