import test from "node:test";
import assert from "node:assert/strict";
import {
  makeArchive, page, cardPage, standardItems, baseFeed, captureTime,
  cardRuleInput, queuedFetcher
} from "../helpers.js";

// These tests pin the rule that a refresh must freeze its layout configuration
// before the request leaves the process, so an operator switching rules while
// the response is still in flight cannot make one capture mix two revisions'
// candidate counts or quality water levels.
test("a rule switched while a refresh is in flight does not change that response's interpretation", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = queuedFetcher();
  fetcher.setGate(gate);
  fetcher.enqueue({ html: cardPage([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]) });

  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  // Refresh starts while the feed is still on the legacy generic extractor.
  const inFlight = archive.refreshFeed("daily-main");
  assert.equal(archive.refreshes.pending("daily-main"), true);

  // Switch to the card rule before the held response is released.
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  assert.equal(archive.feedStatus("daily-main").activeRuleRevision, candidate.revision);

  release();
  const result = await inFlight;

  // The held response must be explained by the legacy context captured at
  // refresh start, not the rule activated in the meantime.
  assert.equal(result.rule.ruleId, "legacy-default");
  assert.equal(result.capture.rule.ruleId, "legacy-default");
  assert.equal(result.capture.rule.extractorStatus, "legacy");
  assert.equal(result.outcome, "accepted");
  const [run] = archive.listCaptures("daily-main", 1);
  assert.equal(run.ruleId, "legacy-default");
  assert.equal(run.ruleRevision, null);
});

test("a refresh started under a card rule keeps that rule after a mid-flight rollback", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = queuedFetcher();
  fetcher.setGate(gate);
  fetcher.enqueue({ html: cardPage([{ id: 1 }, { id: 2 }, { id: 3 }]) });

  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);

  const inFlight = archive.refreshFeed("daily-main");
  // Operator rolls back to the legacy default while the request is in flight.
  archive.deactivateLayoutRule("daily-main");
  assert.equal(archive.feedStatus("daily-main").activeRuleRevision, null);

  release();
  const result = await inFlight;
  assert.equal(result.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(result.rule.ruleRevision, candidate.revision);
  assert.equal(result.capture.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(result.capture.rule.extractorStatus, "rule_matched");
  assert.equal(result.capture.candidateCount, 3);
  assert.equal(result.outcome, "accepted");
});

test("a mid-flight rule switch to an unrecognised layout still rejects with the frozen rule", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = queuedFetcher();
  fetcher.setGate(gate);
  // The held response is a legacy directory page, which the card rule cannot match.
  fetcher.enqueue({ html: page(standardItems(4)) });

  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);

  const inFlight = archive.refreshFeed("daily-main");
  // Even if the rule were withdrawn mid-flight, the frozen card rule must be used.
  archive.deactivateLayoutRule("daily-main");
  release();
  const result = await inFlight;

  assert.equal(result.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.capture.accepted, false);
  assert.equal(result.capture.rule.extractorStatus, "rule_unmatched");
  assert.match(result.capture.reason, /layout_container_not_found/);
});

test("controllable fetcher returns queued responses in strict enqueue order across refreshes", async (t) => {
  const fetcher = queuedFetcher([
    { html: cardPage([{ id: 1 }]) },
    { html: cardPage([{ id: 2 }, { id: 3 }]) }
  ]);
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);

  const first = await archive.refreshFeed("daily-main");
  const second = await archive.refreshFeed("daily-main");
  assert.equal(first.capture.candidateCount, 1);
  assert.equal(second.capture.candidateCount, 2);
  const runs = archive.listCaptures("daily-main");
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.ruleId === cardRuleInput.ruleId));
});

test("a failed queued request is recorded against the frozen rule context", async (t) => {
  const fetcher = queuedFetcher([
    Object.assign(new Error("upstream reset"), { code: "fetch_failed", attemptCount: 2 })
  ]);
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "fetch_failed" });
  const [attempt] = archive.listFetchAttempts("daily-main");
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.errorCode, "fetch_failed");
  assert.equal(archive.listCaptures("daily-main").length, 0);
});
