import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NewsArchive } from "../../src/service/archive.js";
import { page, standardItems, baseFeed, captureTime, cardRuleInput } from "../helpers.js";

// Build a database at the original schema 1 (before layout rules existed).
function createLegacyV1Database(filename) {
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE feeds (
      feed_id TEXT PRIMARY KEY, base_url TEXT NOT NULL, allowed_hosts_json TEXT NOT NULL,
      minimum_items INTEGER NOT NULL DEFAULT 3, missing_threshold INTEGER NOT NULL DEFAULT 3,
      last_accepted_at TEXT, last_item_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE captures (
      capture_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      captured_at TEXT NOT NULL, accepted INTEGER NOT NULL, candidate_count INTEGER NOT NULL,
      normalized_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL,
      duplicate_count INTEGER NOT NULL, reason TEXT, UNIQUE(feed_id, fingerprint)
    );
    CREATE TABLE articles (
      article_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL, canonical_url TEXT NOT NULL,
      title TEXT NOT NULL, published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1, missing_streak INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'visible', review_state TEXT NOT NULL DEFAULT 'unreviewed',
      review_note TEXT, review_revision INTEGER NOT NULL DEFAULT 0, UNIQUE(feed_id, canonical_url)
    );
    CREATE TABLE capture_items (
      capture_id INTEGER NOT NULL, article_id INTEGER NOT NULL, source_index INTEGER NOT NULL,
      PRIMARY KEY(capture_id, article_id)
    );
    CREATE TABLE fetch_attempts (
      attempt_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL, outcome TEXT NOT NULL, http_status INTEGER,
      attempt_count INTEGER NOT NULL, requested_url TEXT NOT NULL, final_url TEXT,
      capture_id INTEGER, error_code TEXT, error_message TEXT
    );
    CREATE TABLE review_events (
      event_id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL, prior_state TEXT NOT NULL,
      next_state TEXT NOT NULL, note TEXT, revision INTEGER NOT NULL, changed_at TEXT NOT NULL
    );
  `);
  database.close();
}

test("migrates a schema 1 archive in place and keeps every existing record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-migrate-"));
  const filename = join(directory, "archive.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  createLegacyV1Database(filename);

  // First open migrates and reads back historical data.
  const archive = new NewsArchive(filename);
  t.after(() => archive.close());
  archive.registerFeed(baseFeed);
  const result = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  assert.equal(result.accepted, true);
  assert.equal(result.rule.ruleId, "legacy-default");
  const [run] = archive.listCaptures("daily-main", 1);
  assert.equal(run.ruleId, "legacy-default");
  assert.equal(run.ruleRevision, null);
  assert.equal(archive.listItems("daily-main").statistics.total, 4);

  // The upgraded database supports the full layout-rule lifecycle.
  const rule = archive.createLayoutRule("daily-main", cardRuleInput);
  const activated = archive.activateLayoutRule("daily-main", rule.ruleId);
  assert.equal(activated.status, "active");
  assert.equal(archive.feedStatus("daily-main").activeRuleRevision, activated.revision);
  archive.close();

  // Reopening a migrated database must not re-run or break anything.
  const reopened = new NewsArchive(filename);
  t.after(() => reopened.close());
  assert.equal(reopened.feedStatus("daily-main").activeRuleRevision, activated.revision);
  assert.equal(reopened.listItems("daily-main").statistics.total, 4);
  assert.equal(reopened.listLayoutRules("daily-main").length, 1);
});
