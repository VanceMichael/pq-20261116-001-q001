import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  makeArchive, page, cardPage, standardItems, baseFeed, captureTime,
  cardRuleInput, queuedFetcher, fixturePath
} from "../helpers.js";

const cardFixturePath = fileURLToPath(new URL("../../fixtures/card-feed.html", import.meta.url));
const legacyFixturePath = fixturePath;

async function cardHtml() {
  return readFile(cardFixturePath, "utf8");
}
async function legacyHtml() {
  return readFile(legacyFixturePath, "utf8");
}

test("legacy feeds keep the generic extractor as the default with no active rule", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const result = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  assert.equal(result.accepted, true);
  assert.equal(result.rule.ruleId, "legacy-default");
  assert.equal(result.rule.ruleRevision, null);
  assert.equal(result.rule.extractorStatus, "legacy");
  const [run] = archive.listCaptures("daily-main", 1);
  assert.equal(run.ruleId, "legacy-default");
  assert.equal(archive.feedStatus("daily-main").activeRuleRevision, null);
});

test("a replay keeps the rule attribution of the capture that first stored the page", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  const html = cardPage([{ id: 1 }, { id: 2 }, { id: 3 }]);
  const first = archive.importSnapshot("daily-main", html, captureTime(1));
  assert.equal(first.replay, false);
  const replay = archive.importSnapshot("daily-main", html, captureTime(2));
  assert.equal(replay.replay, true);
  assert.equal(replay.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(replay.rule.ruleRevision, candidate.revision);
  assert.equal(replay.rule.extractorStatus, "rule_matched");
});

test("a stored candidate does not change capture behaviour before activation", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.revision, 1);
  // The card page would fail under the scoped rule, but the candidate is inert.
  const result = archive.importSnapshot("daily-main", await cardHtml(), captureTime(1));
  assert.equal(result.rule.ruleId, "legacy-default");
  assert.equal(result.accepted, true);
  assert.ok(result.candidateCount >= 10);
});

test("previews a stored rule against a page without persisting anything", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  const preview = archive.previewLayoutRule("daily-main", await cardHtml(), { ruleId: candidate.ruleId });
  assert.equal(preview.matched, true);
  assert.equal(preview.candidateCount, 5);
  assert.equal(preview.normalizedCount, 5);
  assert.equal(preview.wouldPassMinimum, true);
  assert.equal(preview.sample[0].title, "夜间急诊服务扩容上线");
  assert.equal(archive.listCaptures("daily-main").length, 0);
});

test("previews an ad-hoc candidate body that was never stored", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const preview = archive.previewLayoutRule("daily-main", await cardHtml(), { candidate: cardRuleInput });
  assert.equal(preview.status, "preview");
  assert.equal(preview.candidateCount, 5);
  assert.equal(archive.listLayoutRules("daily-main").length, 0);
});

test("preview explains a rule whose container is absent instead of pretending success", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const preview = archive.previewLayoutRule("daily-main", page(standardItems(3)), { candidate: cardRuleInput });
  assert.equal(preview.matched, false);
  assert.match(preview.extractorReason, /layout_container_not_found/);
  assert.equal(preview.candidateCount, 0);
  assert.equal(preview.wouldPassMinimum, false);
});

test("activating a rule switches only that feed and names the rule in capture records", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.registerFeed({ ...baseFeed, feedId: "other-feed" });
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  const activated = archive.activateLayoutRule("daily-main", candidate.ruleId);
  assert.equal(activated.status, "active");
  assert.equal(archive.feedStatus("daily-main").activeRuleRevision, activated.revision);

  const cardResult = archive.importSnapshot("daily-main", await cardHtml(), captureTime(1));
  assert.equal(cardResult.accepted, true);
  assert.equal(cardResult.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(cardResult.rule.extractorStatus, "rule_matched");
  assert.equal(cardResult.candidateCount, 5);
  assert.equal(cardResult.stats.visible, 5);
  // The navigation links must not be treated as articles.
  assert.ok(archive.listItems("daily-main").items.every((item) => item.canonicalUrl.includes("/cards/")));

  // The other feed is completely unaffected and still on the legacy extractor.
  const other = archive.importSnapshot("other-feed", page(standardItems(4)), captureTime(1));
  assert.equal(other.rule.ruleId, "legacy-default");
  assert.equal(other.candidateCount, 4);
});

test("a rule that cannot recognise a page yields an explainable rejection, not a nav-bar list", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  // Feed now serves the legacy directory layout, which the card rule cannot match.
  const result = archive.importSnapshot("daily-main", await legacyHtml(), captureTime(1));
  assert.equal(result.accepted, false);
  assert.equal(result.rule.extractorStatus, "rule_unmatched");
  assert.match(result.reason, /layout_container_not_found/);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.stats.total, 0);
  const [run] = archive.listCaptures("daily-main", 1);
  assert.equal(run.accepted, false);
  assert.equal(run.extractorStatus, "rule_unmatched");
  assert.match(run.reason, /layout_container_not_found/);
});

test("withdrawing the active rule returns the feed to the legacy default", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  const withdrawn = archive.deactivateLayoutRule("daily-main");
  assert.equal(withdrawn.status, "active");
  assert.equal(archive.feedStatus("daily-main").activeRuleRevision, null);
  const result = archive.importSnapshot("daily-main", await legacyHtml(), captureTime(2));
  assert.equal(result.accepted, true);
  assert.equal(result.rule.ruleId, "legacy-default");
  assert.equal(result.rule.extractorStatus, "legacy");
  assert.equal(result.candidateCount, 6);
  const rules = archive.listLayoutRules("daily-main");
  assert.equal(rules[0].status, "withdrawn");
});

test("rollback then a fresh candidate restores scoped extraction on the same feed", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  archive.deactivateLayoutRule("daily-main");
  // The withdrawn revision is immutable; a fresh candidate revision is the way back.
  const recreated = archive.createLayoutRule("daily-main", cardRuleInput);
  const reactivated = archive.activateLayoutRule("daily-main", recreated.ruleId);
  assert.equal(reactivated.status, "active");
  const result = archive.importSnapshot("daily-main", await cardHtml(), captureTime(3));
  assert.equal(result.accepted, true);
  assert.equal(result.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(result.candidateCount, 5);
});

test("a rule-specific minimum item water level overrides the feed default", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed({ ...baseFeed, minimumItems: 2 });
  const candidate = archive.createLayoutRule("daily-main", { ...cardRuleInput, minimumItems: 5 });
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  const small = cardPage([{ id: 1 }, { id: 2 }, { id: 3 }]);
  const result = archive.importSnapshot("daily-main", small, captureTime(1));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /too_few_usable_items:3<5/);
  assert.equal(result.rule.minimumItems, 5);
});

test("editing a rule grows a new revision and leaves history auditable", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const first = archive.createLayoutRule("daily-main", cardRuleInput);
  const second = archive.createLayoutRule("daily-main", { ...cardRuleInput, minimumItems: 4 });
  assert.equal(second.revision, first.revision + 1);
  const rules = archive.listLayoutRules("daily-main");
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.status === "candidate"));
});

test("rejects activation of an unknown rule and keeps withdrawn revisions immutable", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const candidate = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", candidate.ruleId);
  archive.deactivateLayoutRule("daily-main");
  await assert.rejects(
    async () => archive.activateLayoutRule("daily-main", "missing-rule"),
    /unknown layout rule/
  );
  // The withdrawn rule itself cannot be re-activated; a fresh candidate revision is required.
  await assert.rejects(
    async () => archive.activateLayoutRule("daily-main", candidate.ruleId),
    /withdrawn and cannot be activated/
  );
  const recreated = archive.createLayoutRule("daily-main", cardRuleInput);
  assert.equal(recreated.status, "candidate");
  assert.equal(recreated.revision, 2);
  assert.doesNotThrow(() => archive.activateLayoutRule("daily-main", recreated.ruleId));
});
