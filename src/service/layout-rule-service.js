import { extractScopedLinks } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { compileRule, resolveCaptureContext } from "../feed/layout-rule.js";

// Owns the candidate -> preview -> activate -> withdraw lifecycle for one
// feed's layout rules. A candidate never changes capture behaviour until it is
// explicitly activated, and every operation is scoped to a single feed so a
// switch cannot affect any other source.
export class LayoutRuleService {
  constructor({ feeds, rules, clock = () => new Date() }) {
    this.feeds = feeds;
    this.rules = rules;
    this.clock = clock;
  }

  requireFeed(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    return feed;
  }

  createCandidate(feedId, input) {
    this.requireFeed(feedId);
    return this.rules.createCandidate(feedId, input, this.clock().toISOString());
  }

  listRules(feedId) {
    this.requireFeed(feedId);
    return this.rules.list(feedId);
  }

  getRule(feedId, ruleId) {
    this.requireFeed(feedId);
    return this.rules.get(feedId, ruleId);
  }

  activate(feedId, ruleId) {
    this.requireFeed(feedId);
    return this.rules.activate(feedId, ruleId, this.clock().toISOString());
  }

  deactivate(feedId) {
    this.requireFeed(feedId);
    return this.rules.deactivate(feedId, this.clock().toISOString());
  }

  // Dry-run a rule (by id, or an ad-hoc candidate body) against a saved page.
  // Nothing is persisted: operators use this to verify the region and counts
  // before activating the rule.
  preview(feedId, html, { ruleId = null, candidate = null } = {}) {
    const feed = this.requireFeed(feedId);
    let rule;
    if (ruleId) {
      rule = this.rules.get(feedId, ruleId);
      if (!rule) throw new Error(`unknown layout rule: ${ruleId}`);
    } else if (candidate) {
      rule = { ...candidate, ruleId: candidate.ruleId ?? "preview" };
    } else {
      throw new TypeError("preview requires a ruleId or a candidate rule body");
    }
    const compiled = compileRule(rule);
    const extracted = extractScopedLinks(html, feed.baseUrl, compiled);
    const normalized = normalizeCandidates(extracted.candidates, {
      baseUrl: feed.baseUrl,
      allowedHosts: feed.allowedHosts
    });
    const effectiveMinimumItems = rule.minimumItems ?? feed.minimumItems;
    return {
      feedId,
      ruleId: rule.ruleId,
      revision: rule.revision ?? null,
      status: rule.status ?? "preview",
      matched: extracted.matched,
      extractorReason: extracted.reason,
      candidateCount: extracted.candidates.length,
      normalizedCount: normalized.records.length,
      rejectedCount: normalized.rejected.length,
      duplicateCount: normalized.duplicateCount,
      minimumItems: effectiveMinimumItems,
      wouldPassMinimum: normalized.records.length >= effectiveMinimumItems,
      rejected: normalized.rejected,
      sample: normalized.records.slice(0, 10).map((record) => ({
        canonicalUrl: record.canonicalUrl,
        title: record.title,
        publishedAt: record.publishedAt
      }))
    };
  }

  // Resolve the immutable configuration a single capture/refresh must use.
  // Called once before a response is interpreted so an in-flight rule switch
  // cannot mix two revisions' candidate counts or quality water levels.
  resolveContext(feedId) {
    const feed = this.requireFeed(feedId);
    const activeRule = this.rules.active(feedId);
    return resolveCaptureContext(feed, activeRule);
  }
}
