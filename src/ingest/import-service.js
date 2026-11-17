import { extractLinks, extractScopedLinks, pageFingerprint } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { compileRule, resolveCaptureContext } from "../feed/layout-rule.js";
import { validateFeedId } from "../store/feed-repository.js";
import { assessCapture, validateCapturedAt } from "./capture-policy.js";

export class ImportService {
  constructor({ database, feeds, captures, articles, rules = null, clock = () => new Date() }) {
    this.database = database;
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
    this.rules = rules;
    this.clock = clock;
  }

  // Resolve the configuration that will explain this capture. When an explicit
  // context is supplied (for example captured at refresh start, before an
  // in-flight rule switch) it is used verbatim; otherwise the current active
  // rule is resolved here. The legacy generic extractor remains the default
  // when no rule is active, preserving the original interface behaviour.
  resolveContext(feedId, explicitContext) {
    if (explicitContext) return explicitContext;
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const activeRule = this.rules ? this.rules.active(feedId) : null;
    return resolveCaptureContext(feed, activeRule);
  }

  extractWithContext(html, context) {
    if (!context.rule) {
      return { candidates: extractLinks(html, context.baseUrl), matched: true, extractorStatus: "legacy", extractorReason: null };
    }
    const compiled = compileRule(context.rule);
    const result = extractScopedLinks(html, context.baseUrl, compiled);
    return {
      candidates: result.candidates,
      matched: result.matched,
      extractorStatus: result.matched ? "rule_matched" : "rule_unmatched",
      extractorReason: result.reason
    };
  }

  importHtml(feedId, html, capturedAtValue, explicitContext = null) {
    validateFeedId(feedId);
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    // Snapshot the configuration once; everything below uses this same context.
    const context = this.resolveContext(feedId, explicitContext);
    const capturedAt = validateCapturedAt(capturedAtValue, this.clock());
    const fingerprint = pageFingerprint(html);
    const previous = this.captures.findByFingerprint(feedId, fingerprint);
    if (previous) {
      return {
        ...previous,
        replay: true,
        // A replay keeps the attribution of the capture that first stored the
        // page, presented in the same shape as a fresh capture response.
        rule: {
          ruleId: previous.ruleId,
          ruleRevision: previous.ruleRevision,
          minimumItems: previous.ruleMinimumItems ?? context.minimumItems,
          extractorStatus: previous.extractorStatus,
          extractorReason: previous.reason && previous.reason.startsWith("layout_") ? previous.reason : null
        },
        stats: this.articles.stats(feedId)
      };
    }

    const extracted = this.extractWithContext(html, context);
    const candidates = extracted.candidates;
    const normalized = normalizeCandidates(candidates, {
      baseUrl: context.baseUrl,
      allowedHosts: context.allowedHosts
    });

    // A rule that cannot locate its region must produce an explainable reject,
    // never a silent fall back to generic whole-page extraction (which could
    // mistake a navigation bar for the article list).
    let ruleFailureReason = null;
    if (context.rule && !extracted.matched) {
      ruleFailureReason = extracted.extractorReason;
    } else if (context.rule && extracted.matched && normalized.records.length === 0) {
      ruleFailureReason = extracted.extractorReason ?? "layout_no_usable_items";
    }

    const policy = assessCapture({
      candidateCount: candidates.length,
      normalizedCount: normalized.records.length,
      rejectedCount: normalized.rejected.length,
      previousCount: feed.lastItemCount,
      capturedAt,
      feed,
      minimumItems: context.minimumItems
    });
    const accepted = policy.accepted && ruleFailureReason === null;
    const reason = ruleFailureReason ?? policy.reason;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const captureId = this.captures.create({
        feedId,
        fingerprint,
        capturedAt,
        accepted,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason,
        ruleId: context.ruleId,
        ruleRevision: context.ruleRevision,
        ruleMinimumItems: context.minimumItems,
        extractorStatus: extracted.extractorStatus
      });
      if (accepted) {
        this.articles.recordCapture(captureId, feed, normalized.records, capturedAt);
        this.feeds.markAccepted(feedId, capturedAt, normalized.records.length);
      }
      this.database.exec("COMMIT");
      return {
        captureId,
        feedId,
        fingerprint,
        capturedAt,
        accepted,
        replay: false,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason,
        rejected: normalized.rejected,
        rule: {
          ruleId: context.ruleId,
          ruleRevision: context.ruleRevision,
          minimumItems: context.minimumItems,
          extractorStatus: extracted.extractorStatus,
          extractorReason: extracted.extractorReason
        },
        stats: this.articles.stats(feedId)
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
