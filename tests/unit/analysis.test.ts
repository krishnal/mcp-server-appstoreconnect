import { describe, expect, it } from 'vitest';
import { prioritize } from '../../src/analysis/prioritize.js';
import { clusterFeedback, textSimilarity } from '../../src/analysis/similarity.js';
import { generateTodoMarkdown } from '../../src/analysis/todo.js';
import { feedbackItem } from '../helpers/fixtures.js';

describe('textSimilarity', () => {
  it('scores near-duplicates high and unrelated text low', () => {
    const near = textSimilarity(
      'The checkout button overlaps the total price label',
      'Checkout button is overlapping the total price',
    );
    const far = textSimilarity(
      'The checkout button overlaps the total price label',
      'Dark mode colors look washed out on the settings screen',
    );
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(0.25);
    expect(near).toBeGreaterThan(far);
  });
});

describe('clusterFeedback', () => {
  it('groups similar comments and never mixes kinds', () => {
    const clusters = clusterFeedback([
      { item: feedbackItem({ id: 'a' }) },
      { item: feedbackItem({ id: 'b', comment: 'Checkout button overlapping the total price' }) },
      { item: feedbackItem({ id: 'c', comment: 'Profile photo upload fails with a spinner forever' }) },
      {
        item: feedbackItem({
          id: 'd',
          kind: 'crash',
          comment: 'The checkout button overlaps the total price label',
        }),
      },
    ]);

    const byId = new Map(
      clusters.flatMap((c) => c.members.map((m) => [m.feedbackId, c.groupId] as const)),
    );
    expect(byId.get('a')).toBe(byId.get('b'));
    expect(byId.get('a')).not.toBe(byId.get('c'));
    // Same words, but a crash is a different failure mode than UI feedback.
    expect(byId.get('a')).not.toBe(byId.get('d'));
  });
});

describe('prioritize', () => {
  const now = new Date('2026-07-03T12:00:00Z');

  it('excludes processed items and ranks crashes high by default', () => {
    const groups = prioritize(
      [
        { item: feedbackItem({ id: 'ui' }), processed: false },
        { item: feedbackItem({ id: 'crash', kind: 'crash' }), processed: false },
        { item: feedbackItem({ id: 'done' }), processed: true },
      ],
      now,
    );
    expect(groups.flatMap((g) => g.feedbackIds)).not.toContain('done');
    expect(groups[0]!.representative.id).toBe('crash');
    expect(groups[0]!.severity).toBe('high');
  });

  it('frequency and severity dominate the ranking', () => {
    const groups = prioritize(
      [
        { item: feedbackItem({ id: 'a' }), processed: false, severity: 'high', groupId: 'g1' },
        { item: feedbackItem({ id: 'b' }), processed: false, severity: 'high', groupId: 'g1' },
        { item: feedbackItem({ id: 'c' }), processed: false, severity: 'high' },
        { item: feedbackItem({ id: 'd' }), processed: false, severity: 'low' },
      ],
      now,
    );
    expect(groups[0]!.groupId).toBe('g1');
    expect(groups[0]!.count).toBe(2);
    expect(groups.at(-1)!.representative.id).toBe('d');
    expect(groups[0]!.score).toBeGreaterThan(groups[1]!.score);
  });
});

describe('generateTodoMarkdown', () => {
  it('produces the full engineering checklist with context', () => {
    const markdown = generateTodoMarkdown(
      feedbackItem(),
      {
        summary: 'Checkout overlap',
        problem: 'Button overlaps label',
        severity: 'high',
        confidence: 0.85,
        screen: 'Checkout',
        suspectedComponent: 'CheckoutFooterView',
        suggestedFix: 'Add a vertical constraint',
      },
      ['./screenshots/fb-1/screenshot-1.png'],
    );

    expect(markdown).toContain('## TODO — Checkout overlap');
    expect(markdown).toContain('Severity: **high**');
    expect(markdown).toContain('- [ ] Reproduce on the "Checkout" screen');
    expect(markdown).toContain('screenshot-1.png');
    expect(markdown).toContain('Add a vertical constraint');
    expect(markdown).toContain('> The checkout button overlaps the total price label');
  });

  it('handles crash feedback without an analysis', () => {
    const markdown = generateTodoMarkdown(feedbackItem({ id: 'c1', kind: 'crash', comment: undefined }));
    expect(markdown).toContain('get_crash_log');
    expect(markdown).toContain('- [ ] Implement fix');
  });
});
