/**
 * Local state — SQLite via node:sqlite (built into Node ≥ 24).
 *
 * Chosen over better-sqlite3 deliberately: identical synchronous API, zero
 * native compilation, and it survives esbuild single-file Lambda bundling and
 * slim Docker images untouched. Swap the backend by re-implementing this
 * class's public surface.
 *
 * Persists everything Apple's API has no concept of: processed status, cached
 * feedback payloads (so grouping/prioritizing work offline), downloaded
 * screenshot paths, AI analyses, generated TODOs, duplicate groups, and
 * linked issue-tracker references (the idempotency record for create_issue).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FeedbackItem, FeedbackKind } from '../asc/types.js';

export type AnalysisSource = 'api' | 'host';

export interface StoredAnalysis {
  feedbackId: string;
  analysis: Record<string, unknown>;
  source: AnalysisSource;
  model?: string;
  createdAt: string;
}

export interface StoredScreenshot {
  feedbackId: string;
  idx: number;
  localPath: string;
  width?: number;
  height?: number;
  downloadedAt: string;
}

export interface StoredIssue {
  feedbackId: string;
  provider: string;
  issueKey: string;
  issueUrl: string;
  createdAt: string;
}

export interface StoredFeedback {
  item: FeedbackItem;
  processed: boolean;
  processedAt?: string;
  processedNote?: string;
  firstSeenAt: string;
}

export interface DuplicateGroupMember {
  groupId: string;
  feedbackId: string;
  similarity: number;
}

export interface ListLocalOptions {
  kind?: FeedbackKind;
  appId?: string;
  processed?: boolean;
  /** ISO date bounds applied to the feedback's createdDate. */
  since?: string;
  until?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('screenshot','crash')),
  app_id         TEXT NOT NULL DEFAULT '',
  created_date   TEXT NOT NULL DEFAULT '',
  comment        TEXT,
  build_number   TEXT,
  device_model   TEXT,
  os_version     TEXT,
  raw_json       TEXT NOT NULL,
  processed      INTEGER NOT NULL DEFAULT 0,
  processed_at   TEXT,
  processed_note TEXT,
  first_seen_at  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_processed ON feedback (processed, created_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_app ON feedback (app_id, created_date DESC);

CREATE TABLE IF NOT EXISTS screenshots (
  feedback_id   TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  local_path    TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  downloaded_at TEXT NOT NULL,
  PRIMARY KEY (feedback_id, idx)
);

CREATE TABLE IF NOT EXISTS analyses (
  feedback_id   TEXT PRIMARY KEY,
  analysis_json TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('api','host')),
  model         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  feedback_id TEXT PRIMARY KEY,
  markdown    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  group_id    TEXT NOT NULL,
  feedback_id TEXT NOT NULL,
  similarity  REAL NOT NULL,
  PRIMARY KEY (group_id, feedback_id)
);

CREATE TABLE IF NOT EXISTS issues (
  feedback_id TEXT NOT NULL,
  provider    TEXT NOT NULL,
  issue_key   TEXT NOT NULL,
  issue_url   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (feedback_id, provider)
);
`;

export class FeedbackStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  // -------------------------------------------------------------------------
  // Feedback cache + processed state
  // -------------------------------------------------------------------------

  /** Insert or refresh cached feedback. Local state (processed) is preserved. */
  upsertFeedback(items: FeedbackItem[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO feedback (id, kind, app_id, created_date, comment, build_number,
                            device_model, os_version, raw_json, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        app_id = CASE WHEN excluded.app_id != '' THEN excluded.app_id ELSE feedback.app_id END,
        created_date = excluded.created_date,
        comment = excluded.comment,
        build_number = COALESCE(excluded.build_number, feedback.build_number),
        device_model = excluded.device_model,
        os_version = excluded.os_version,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    for (const item of items) {
      stmt.run(
        item.id,
        item.kind,
        item.appId,
        item.createdDate,
        item.comment ?? null,
        item.buildNumber ?? null,
        item.device.model ?? null,
        item.device.osVersion ?? null,
        JSON.stringify(item),
        now,
        now,
      );
    }
  }

  getFeedback(id: string): StoredFeedback | undefined {
    const row = this.db
      .prepare('SELECT raw_json, processed, processed_at, processed_note, first_seen_at FROM feedback WHERE id = ?')
      .get(id) as
      | {
          raw_json: string;
          processed: number;
          processed_at: string | null;
          processed_note: string | null;
          first_seen_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      item: JSON.parse(row.raw_json) as FeedbackItem,
      processed: row.processed === 1,
      processedAt: row.processed_at ?? undefined,
      processedNote: row.processed_note ?? undefined,
      firstSeenAt: row.first_seen_at,
    };
  }

  listLocal(options: ListLocalOptions = {}): StoredFeedback[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options.appId) {
      clauses.push('app_id = ?');
      params.push(options.appId);
    }
    if (options.processed !== undefined) {
      clauses.push('processed = ?');
      params.push(options.processed ? 1 : 0);
    }
    if (options.since) {
      clauses.push('created_date >= ?');
      params.push(options.since);
    }
    if (options.until) {
      clauses.push('created_date <= ?');
      params.push(options.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT raw_json, processed, processed_at, processed_note, first_seen_at
         FROM feedback ${where} ORDER BY created_date DESC LIMIT ?`,
      )
      .all(...params, options.limit ?? 100) as {
      raw_json: string;
      processed: number;
      processed_at: string | null;
      processed_note: string | null;
      first_seen_at: string;
    }[];
    return rows.map((row) => ({
      item: JSON.parse(row.raw_json) as FeedbackItem,
      processed: row.processed === 1,
      processedAt: row.processed_at ?? undefined,
      processedNote: row.processed_note ?? undefined,
      firstSeenAt: row.first_seen_at,
    }));
  }

  /** Returns false when the id is unknown locally. */
  setProcessed(id: string, processed: boolean, note?: string): boolean {
    const result = this.db
      .prepare('UPDATE feedback SET processed = ?, processed_at = ?, processed_note = ? WHERE id = ?')
      .run(processed ? 1 : 0, processed ? new Date().toISOString() : null, note ?? null, id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Screenshots
  // -------------------------------------------------------------------------

  saveScreenshot(shot: Omit<StoredScreenshot, 'downloadedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO screenshots (feedback_id, idx, local_path, width, height, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feedback_id, idx) DO UPDATE SET
           local_path = excluded.local_path, width = excluded.width,
           height = excluded.height, downloaded_at = excluded.downloaded_at`,
      )
      .run(
        shot.feedbackId,
        shot.idx,
        shot.localPath,
        shot.width ?? null,
        shot.height ?? null,
        new Date().toISOString(),
      );
  }

  getScreenshots(feedbackId: string): StoredScreenshot[] {
    const rows = this.db
      .prepare(
        'SELECT idx, local_path, width, height, downloaded_at FROM screenshots WHERE feedback_id = ? ORDER BY idx',
      )
      .all(feedbackId) as {
      idx: number;
      local_path: string;
      width: number | null;
      height: number | null;
      downloaded_at: string;
    }[];
    return rows.map((row) => ({
      feedbackId,
      idx: row.idx,
      localPath: row.local_path,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      downloadedAt: row.downloaded_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Analyses & TODOs
  // -------------------------------------------------------------------------

  saveAnalysis(
    feedbackId: string,
    analysis: Record<string, unknown>,
    source: AnalysisSource,
    model?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO analyses (feedback_id, analysis_json, source, model, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(feedback_id) DO UPDATE SET
           analysis_json = excluded.analysis_json, source = excluded.source,
           model = excluded.model, created_at = excluded.created_at`,
      )
      .run(feedbackId, JSON.stringify(analysis), source, model ?? null, new Date().toISOString());
  }

  getAnalysis(feedbackId: string): StoredAnalysis | undefined {
    const row = this.db
      .prepare('SELECT analysis_json, source, model, created_at FROM analyses WHERE feedback_id = ?')
      .get(feedbackId) as
      | { analysis_json: string; source: AnalysisSource; model: string | null; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      feedbackId,
      analysis: JSON.parse(row.analysis_json) as Record<string, unknown>,
      source: row.source,
      model: row.model ?? undefined,
      createdAt: row.created_at,
    };
  }

  saveTodo(feedbackId: string, markdown: string): void {
    this.db
      .prepare(
        `INSERT INTO todos (feedback_id, markdown, created_at) VALUES (?, ?, ?)
         ON CONFLICT(feedback_id) DO UPDATE SET
           markdown = excluded.markdown, created_at = excluded.created_at`,
      )
      .run(feedbackId, markdown, new Date().toISOString());
  }

  getTodo(feedbackId: string): string | undefined {
    const row = this.db.prepare('SELECT markdown FROM todos WHERE feedback_id = ?').get(feedbackId) as
      | { markdown: string }
      | undefined;
    return row?.markdown;
  }

  // -------------------------------------------------------------------------
  // Duplicate groups
  // -------------------------------------------------------------------------

  /** Replace the entire duplicate-group assignment (clustering is global). */
  replaceDuplicateGroups(members: DuplicateGroupMember[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM duplicate_groups');
      const stmt = this.db.prepare(
        'INSERT INTO duplicate_groups (group_id, feedback_id, similarity) VALUES (?, ?, ?)',
      );
      for (const member of members) {
        stmt.run(member.groupId, member.feedbackId, member.similarity);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getDuplicateGroups(): DuplicateGroupMember[] {
    return this.db
      .prepare('SELECT group_id, feedback_id, similarity FROM duplicate_groups ORDER BY group_id')
      .all()
      .map((row) => {
        const r = row as { group_id: string; feedback_id: string; similarity: number };
        return { groupId: r.group_id, feedbackId: r.feedback_id, similarity: r.similarity };
      });
  }

  // -------------------------------------------------------------------------
  // Linked issues (idempotency for create_issue)
  // -------------------------------------------------------------------------

  linkIssue(issue: Omit<StoredIssue, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO issues (feedback_id, provider, issue_key, issue_url, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(feedback_id, provider) DO UPDATE SET
           issue_key = excluded.issue_key, issue_url = excluded.issue_url`,
      )
      .run(issue.feedbackId, issue.provider, issue.issueKey, issue.issueUrl, new Date().toISOString());
  }

  getIssue(feedbackId: string, provider: string): StoredIssue | undefined {
    const row = this.db
      .prepare(
        'SELECT issue_key, issue_url, created_at FROM issues WHERE feedback_id = ? AND provider = ?',
      )
      .get(feedbackId, provider) as
      | { issue_key: string; issue_url: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      feedbackId,
      provider,
      issueKey: row.issue_key,
      issueUrl: row.issue_url,
      createdAt: row.created_at,
    };
  }

  getIssues(feedbackId: string): StoredIssue[] {
    return this.db
      .prepare('SELECT provider, issue_key, issue_url, created_at FROM issues WHERE feedback_id = ?')
      .all(feedbackId)
      .map((row) => {
        const r = row as { provider: string; issue_key: string; issue_url: string; created_at: string };
        return {
          feedbackId,
          provider: r.provider,
          issueKey: r.issue_key,
          issueUrl: r.issue_url,
          createdAt: r.created_at,
        };
      });
  }

  close(): void {
    this.db.close();
  }
}
