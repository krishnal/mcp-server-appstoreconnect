/**
 * Rule evaluation: applicability filter + deterministic checks. Rules that
 * need project facts are reported as skipped (never silently dropped) when no
 * projectPath was scanned.
 */

import type { AppFacts, Finding, GuidelineRule, SkippedCheck } from './types.js';

export function runAudit(
  rules: GuidelineRule[],
  facts: AppFacts,
): { findings: Finding[]; skippedChecks: SkippedCheck[] } {
  const findings: Finding[] = [];
  const skippedChecks: SkippedCheck[] = [];

  for (const rule of rules) {
    if (rule.needsProject && !facts.project) {
      skippedChecks.push({
        ruleId: rule.id,
        guideline: rule.guideline,
        reason: 'Requires projectPath (local Xcode project scan).',
      });
      continue;
    }
    if (!rule.appliesTo(facts)) continue;

    const base = { ruleId: rule.id, guideline: rule.guideline, title: rule.title, link: rule.link, fix: rule.fix };
    if (rule.check) {
      const outcome = rule.check(facts);
      findings.push({
        ...base,
        status: outcome.status,
        detail: outcome.detail,
        facts: outcome.facts,
        ...(outcome.status === 'needs_judgment' && rule.judgment ? { judgment: rule.judgment } : {}),
      });
    } else if (rule.judgment) {
      findings.push({ ...base, status: 'needs_judgment', detail: rule.judgment.question, judgment: rule.judgment });
    }
  }
  return { findings, skippedChecks };
}
