import { mapRuleRow, validateRuleInput } from "../feed/layout-rule.js";

// Persists per-source layout rules and the feed's pointer to the single active
// revision. Rule history is append-only: editing a rule creates a new revision,
// and activating/withdrawing only flips status so every capture can still name
// the exact revision that interpreted it.
export class LayoutRuleRepository {
  constructor(database) {
    this.database = database;
    this.insertRule = database.prepare(`INSERT INTO layout_rules
      (feed_id, rule_key, revision, status, container_selector, item_selector,
       link_pattern, minimum_items, note, created_at, updated_at)
      VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`);
    this.nextRevision = database.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM layout_rules WHERE feed_id=?");
    this.byKey = database.prepare("SELECT * FROM layout_rules WHERE feed_id=? AND rule_key=? ORDER BY revision DESC");
    this.byRowId = database.prepare("SELECT * FROM layout_rules WHERE rule_id=?");
    this.activeForFeed = database.prepare("SELECT * FROM layout_rules WHERE feed_id=? AND status='active' ORDER BY revision DESC LIMIT 1");
    this.listForFeed = database.prepare("SELECT * FROM layout_rules WHERE feed_id=? ORDER BY rule_key, revision DESC");
    this.setStatus = database.prepare("UPDATE layout_rules SET status=?, updated_at=? WHERE rule_id=?");
    this.clearActive = database.prepare("UPDATE layout_rules SET status='withdrawn', updated_at=? WHERE feed_id=? AND status='active'");
    this.setFeedRevision = database.prepare("UPDATE feeds SET active_rule_revision=?, updated_at=? WHERE feed_id=?");
  }

  createCandidate(feedId, input, now) {
    const rule = validateRuleInput(input);
    const revision = Number(this.nextRevision.get(feedId).revision);
    const result = this.insertRule.run(feedId, rule.ruleId, revision,
      rule.containerSelector, rule.itemSelector, rule.linkPattern, rule.minimumItems, rule.note, now, now);
    return this.getByRowId(Number(result.lastInsertRowid));
  }

  getByRowId(rowId) {
    const row = this.byRowId.get(rowId);
    return row ? mapRuleRow(row) : null;
  }

  get(feedId, ruleId) {
    const rows = this.byKey.all(feedId, ruleId);
    return rows.length ? mapRuleRow(rows[0]) : null;
  }

  list(feedId) {
    return this.listForFeed.all(feedId).map(mapRuleRow);
  }

  active(feedId) {
    const row = this.activeForFeed.get(feedId);
    return row ? mapRuleRow(row) : null;
  }

  // Atomically activate one candidate revision and withdraw the previously
  // active rule of the same feed. Other feeds are untouched.
  activate(feedId, ruleId, now) {
    const tx = this.database.prepare("BEGIN IMMEDIATE");
    tx.run();
    try {
      const rows = this.byKey.all(feedId, ruleId);
      const target = rows[0];
      if (!target) throw new Error(`unknown layout rule: ${ruleId}`);
      if (target.status === "withdrawn") throw new Error(`layout rule ${ruleId} is withdrawn and cannot be activated`);
      this.clearActive.run(now, feedId);
      this.setStatus.run("active", now, target.rule_id);
      this.setFeedRevision.run(target.revision, now, feedId);
      this.database.exec("COMMIT");
      return this.getByRowId(target.rule_id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // Withdraw the active rule and return the feed to the legacy default.
  deactivate(feedId, now) {
    const tx = this.database.prepare("BEGIN IMMEDIATE");
    tx.run();
    try {
      const active = this.activeForFeed.get(feedId);
      if (!active) {
        this.database.exec("COMMIT");
        return null;
      }
      this.clearActive.run(now, feedId);
      this.setFeedRevision.run(null, now, feedId);
      this.database.exec("COMMIT");
      return mapRuleRow(active);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
