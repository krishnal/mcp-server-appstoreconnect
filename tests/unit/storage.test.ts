import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeedbackStore } from '../../src/storage/feedback-store.js';
import { feedbackItem } from '../helpers/fixtures.js';

let store: FeedbackStore;

beforeEach(() => {
  store = new FeedbackStore(':memory:');
});
afterEach(() => {
  store.close();
});

describe('feedback cache', () => {
  it('upserts and reads back the full item', () => {
    store.upsertFeedback([feedbackItem()]);
    const stored = store.getFeedback('fb-1');
    expect(stored?.item).toMatchObject({ id: 'fb-1', comment: expect.stringContaining('checkout') });
    expect(stored?.processed).toBe(false);
  });

  it('re-upserting refreshed data preserves processed state', () => {
    store.upsertFeedback([feedbackItem()]);
    store.setProcessed('fb-1', true, 'done');

    store.upsertFeedback([feedbackItem({ comment: 'updated comment' })]);
    const stored = store.getFeedback('fb-1');
    expect(stored?.item.comment).toBe('updated comment');
    expect(stored?.processed).toBe(true);
    expect(stored?.processedNote).toBe('done');
  });

  it('setProcessed returns false for unknown ids', () => {
    expect(store.setProcessed('ghost', true)).toBe(false);
  });

  it('listLocal filters by kind, processed state and date range', () => {
    store.upsertFeedback([
      feedbackItem({ id: 'a', createdDate: '2026-06-01T00:00:00Z' }),
      feedbackItem({ id: 'b', kind: 'crash', createdDate: '2026-07-01T00:00:00Z' }),
      feedbackItem({ id: 'c', createdDate: '2026-07-02T00:00:00Z' }),
    ]);
    store.setProcessed('a', true);

    expect(store.listLocal({ processed: false }).map((s) => s.item.id)).toEqual(['c', 'b']);
    expect(store.listLocal({ kind: 'crash' }).map((s) => s.item.id)).toEqual(['b']);
    expect(store.listLocal({ since: '2026-07-02T00:00:00Z' }).map((s) => s.item.id)).toEqual(['c']);
    expect(store.listLocal({ until: '2026-06-30T00:00:00Z' }).map((s) => s.item.id)).toEqual(['a']);
  });
});

describe('screenshots, analyses, todos', () => {
  it('round-trips screenshot paths per index', () => {
    store.upsertFeedback([feedbackItem()]);
    store.saveScreenshot({ feedbackId: 'fb-1', idx: 0, localPath: '/tmp/s1.png', width: 10, height: 20 });
    store.saveScreenshot({ feedbackId: 'fb-1', idx: 0, localPath: '/tmp/s1-new.png' });

    const shots = store.getScreenshots('fb-1');
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ idx: 0, localPath: '/tmp/s1-new.png' });
  });

  it('stores one analysis per feedback (latest wins) with provenance', () => {
    store.saveAnalysis('fb-1', { severity: 'low' }, 'host');
    store.saveAnalysis('fb-1', { severity: 'high' }, 'api', 'claude-opus-4-8');

    const analysis = store.getAnalysis('fb-1');
    expect(analysis?.analysis).toEqual({ severity: 'high' });
    expect(analysis?.source).toBe('api');
    expect(analysis?.model).toBe('claude-opus-4-8');
  });

  it('round-trips TODO markdown', () => {
    store.saveTodo('fb-1', '## TODO');
    expect(store.getTodo('fb-1')).toBe('## TODO');
    expect(store.getTodo('ghost')).toBeUndefined();
  });
});

describe('duplicate groups and issues', () => {
  it('replaceDuplicateGroups swaps the whole assignment atomically', () => {
    store.replaceDuplicateGroups([
      { groupId: 'g1', feedbackId: 'a', similarity: 1 },
      { groupId: 'g1', feedbackId: 'b', similarity: 0.8 },
    ]);
    store.replaceDuplicateGroups([{ groupId: 'g2', feedbackId: 'c', similarity: 1 }]);

    const groups = store.getDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ groupId: 'g2', feedbackId: 'c' });
  });

  it('links issues idempotently per provider', () => {
    store.linkIssue({ feedbackId: 'fb-1', provider: 'github', issueKey: '#1', issueUrl: 'u1' });
    store.linkIssue({ feedbackId: 'fb-1', provider: 'github', issueKey: '#2', issueUrl: 'u2' });
    store.linkIssue({ feedbackId: 'fb-1', provider: 'linear', issueKey: 'ENG-1', issueUrl: 'u3' });

    expect(store.getIssue('fb-1', 'github')).toMatchObject({ issueKey: '#2' });
    expect(store.getIssues('fb-1')).toHaveLength(2);
  });
});
