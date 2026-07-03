/**
 * Deterministic prioritization.
 *
 * score = severity weight (stored analysis; crashes default high)
 *       + frequency bonus (duplicate-group size)
 *       + recency bonus (newest member)
 * Pure function of local data — no network, trivially unit-testable, and the
 * "reasons" strings let the calling LLM explain the ranking to a human.
 */
import type { FeedbackItem } from '../asc/types.js';
import type { Severity } from './schema.js';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
};

export interface PrioritizeInput {
  item: FeedbackItem;
  severity?: Severity;
  processed: boolean;
  groupId?: string;
}

export interface PrioritizedGroup {
  groupId: string;
  score: number;
  severity: Severity;
  count: number;
  latestDate: string;
  feedbackIds: string[];
  representative: {
    id: string;
    kind: string;
    comment?: string;
    buildNumber?: string;
    deviceModel?: string;
  };
  reasons: string[];
}

export function prioritize(inputs: PrioritizeInput[], now: Date = new Date()): PrioritizedGroup[] {
  // Group by duplicate-group id; ungrouped items form singleton groups.
  const groups = new Map<string, PrioritizeInput[]>();
  for (const input of inputs) {
    if (input.processed) continue; // done is done
    const key = input.groupId ?? `single-${input.item.id}`;
    const members = groups.get(key) ?? [];
    members.push(input);
    groups.set(key, members);
  }

  const result: PrioritizedGroup[] = [];
  for (const [groupId, members] of groups) {
    const severity = effectiveSeverity(members);
    const count = members.length;
    const latest = members.reduce(
      (max, m) => (m.item.createdDate > max ? m.item.createdDate : max),
      '',
    );
    const reasons: string[] = [`severity: ${severity}`];

    let score = SEVERITY_WEIGHT[severity];

    const frequencyBonus = Math.min((count - 1) * 15, 45);
    if (frequencyBonus > 0) {
      score += frequencyBonus;
      reasons.push(`${count} similar reports`);
    }

    const ageDays = latest ? (now.getTime() - Date.parse(latest)) / 86_400_000 : Infinity;
    if (ageDays <= 7) {
      score += 15;
      reasons.push('reported within the last 7 days');
    } else if (ageDays <= 30) {
      score += 8;
    }

    const representative = [...members].sort((a, b) =>
      b.item.createdDate.localeCompare(a.item.createdDate),
    )[0]!;

    result.push({
      groupId,
      score,
      severity,
      count,
      latestDate: latest,
      feedbackIds: members.map((m) => m.item.id),
      representative: {
        id: representative.item.id,
        kind: representative.item.kind,
        comment: representative.item.comment,
        buildNumber: representative.item.buildNumber,
        deviceModel: representative.item.device.model,
      },
      reasons,
    });
  }

  return result.sort((a, b) => b.score - a.score || b.latestDate.localeCompare(a.latestDate));
}

function effectiveSeverity(members: PrioritizeInput[]): Severity {
  const order: Severity[] = ['critical', 'high', 'medium', 'low'];
  let best: Severity | undefined;
  for (const member of members) {
    const severity = member.severity ?? (member.item.kind === 'crash' ? 'high' : undefined);
    if (severity && (!best || order.indexOf(severity) < order.indexOf(best))) {
      best = severity;
    }
  }
  return best ?? 'medium';
}
