/**
 * Engineering TODO checklist generation — deliberately template-based.
 *
 * The checklist structure (reproduce → root-cause → fix → test → verify →
 * close the loop) is fixed engineering process, not something an LLM should
 * improvise per item. Stored analysis enriches the specifics when available.
 */
import type { FeedbackItem } from '../asc/types.js';
import type { FeedbackAnalysis } from './schema.js';

export function generateTodoMarkdown(
  item: FeedbackItem,
  analysis?: FeedbackAnalysis,
  screenshotPaths: string[] = [],
): string {
  const title =
    analysis?.summary ??
    item.comment?.split('\n')[0]?.slice(0, 100) ??
    `${item.kind === 'crash' ? 'Crash' : 'Feedback'} ${item.id}`;

  const lines: string[] = [
    `## TODO — ${title}`,
    '',
    `Feedback \`${item.id}\` (${item.kind})${item.buildNumber ? ` · build ${item.buildNumber}` : ''}${
      item.device.model ? ` · ${item.device.model}` : ''
    }${item.device.osVersion ? ` · ${item.device.platform ?? 'OS'} ${item.device.osVersion}` : ''}`,
    '',
  ];

  if (analysis) {
    lines.push(
      `- Severity: **${analysis.severity}** (confidence ${Math.round(analysis.confidence * 100)}%)`,
    );
    if (analysis.screen) lines.push(`- Affected screen: ${analysis.screen}`);
    if (analysis.suspectedComponent) lines.push(`- Suspected component: ${analysis.suspectedComponent}`);
    lines.push('');
  }

  lines.push('### Checklist', '');

  const reproduceHint = analysis?.screen
    ? ` on the "${analysis.screen}" screen`
    : item.comment
      ? ' following the tester\'s comment'
      : '';
  lines.push(
    `- [ ] Reproduce${reproduceHint}${item.device.model ? ` (tester used ${item.device.model}, ${item.device.platform ?? 'OS'} ${item.device.osVersion ?? '?'})` : ''}`,
  );
  if (item.kind === 'crash') {
    lines.push('- [ ] Pull the crash log (`get_crash_log`) and symbolicate if needed');
    lines.push('- [ ] Identify the crashing frame and root cause');
  } else {
    if (screenshotPaths.length > 0) {
      lines.push(`- [ ] Review screenshot(s): ${screenshotPaths.map((p) => `\`${p}\``).join(', ')}`);
    }
    lines.push('- [ ] Root-cause the defect in the suspected component');
  }
  lines.push(
    analysis?.suggestedFix
      ? `- [ ] Implement fix — suggested approach: ${analysis.suggestedFix}`
      : '- [ ] Implement fix',
    '- [ ] Add a regression test covering this scenario',
    '- [ ] Verify on an affected configuration' +
      (item.device.osVersion ? ` (${item.device.platform ?? 'OS'} ${item.device.osVersion})` : ''),
    '- [ ] Ship in next TestFlight build and confirm with the reporter cohort',
    '- [ ] Mark feedback processed (`mark_processed`)',
  );

  if (item.comment) {
    lines.push('', '### Original comment', '', ...item.comment.split('\n').map((l) => `> ${l}`));
  }

  return lines.join('\n');
}
