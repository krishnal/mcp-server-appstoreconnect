/**
 * Duplicate detection — deterministic lexical similarity (v1).
 *
 * No embeddings, no network: comment similarity is the average of token-set
 * Jaccard and character-bigram Dice, boosted by matching build / device /
 * analysis-screen signals. Greedy clustering against each group's
 * representative (first member) keeps results stable and O(n·groups).
 * Swap `similarity()` for an embedding-based scorer without touching callers.
 */
import type { FeedbackItem } from '../asc/types.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'so', 'that', 'the', 'their',
  'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'when', 'will', 'with',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

/** Lexical similarity of two comments in [0, 1]. */
export function textSimilarity(a: string, b: string): number {
  const tokenScore = jaccard(new Set(tokenize(a)), new Set(tokenize(b)));
  const bigramScore = dice(bigrams(a), bigrams(b));
  return (tokenScore + bigramScore) / 2;
}

export interface ClusterInput {
  item: FeedbackItem;
  /** Affected screen from a stored analysis, when available. */
  analysisScreen?: string;
}

export interface Cluster {
  groupId: string;
  members: { feedbackId: string; similarity: number }[];
}

/**
 * Greedy clustering: iterate newest-first, attach each item to the first
 * group whose representative scores ≥ threshold, else open a new group.
 */
export function clusterFeedback(inputs: ClusterInput[], threshold = 0.55): Cluster[] {
  const clusters: { representative: ClusterInput; cluster: Cluster }[] = [];

  const sorted = [...inputs].sort((a, b) =>
    (b.item.createdDate ?? '').localeCompare(a.item.createdDate ?? ''),
  );

  for (const input of sorted) {
    let best: { cluster: Cluster; score: number } | undefined;
    for (const { representative, cluster } of clusters) {
      const score = pairScore(representative, input);
      if (score >= threshold && (!best || score > best.score)) {
        best = { cluster, score };
      }
    }
    if (best) {
      best.cluster.members.push({ feedbackId: input.item.id, similarity: round(best.score) });
    } else {
      const cluster: Cluster = {
        groupId: `group-${clusters.length + 1}`,
        members: [{ feedbackId: input.item.id, similarity: 1 }],
      };
      clusters.push({ representative: input, cluster });
    }
  }
  return clusters.map((entry) => entry.cluster);
}

function pairScore(a: ClusterInput, b: ClusterInput): number {
  // Crash reports and screenshot feedback describe different failure modes.
  if (a.item.kind !== b.item.kind) return 0;

  let score = textSimilarity(a.item.comment ?? '', b.item.comment ?? '');
  if (a.item.buildNumber && a.item.buildNumber === b.item.buildNumber) score += 0.1;
  if (a.item.device.model && a.item.device.model === b.item.device.model) score += 0.05;
  if (
    a.analysisScreen &&
    b.analysisScreen &&
    a.analysisScreen.toLowerCase() === b.analysisScreen.toLowerCase()
  ) {
    score += 0.15;
  }
  return Math.min(score, 1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
