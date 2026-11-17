import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, cardPage, standardItems, baseFeed, captureTime, cardRuleInput } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

async function start(t, archive) {
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());
  return { base };
}

test("creates a candidate rule and lists rules without affecting the feed", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const { base } = await start(t, archive);
  const created = await fetch(`${base}/v1/feeds/daily-main/layout-rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cardRuleInput)
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(body.rule.status, "candidate");

  const listed = await fetch(`${base}/v1/feeds/daily-main/layout-rules`);
  const payload = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(payload.rules.length, 1);
});

test("rejects a malformed rule with a structured 400 and stores nothing", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/daily-main/layout-rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ruleId: "bad", containerSelector: "#a .b" })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /simple tag/);
  assert.equal(archive.listLayoutRules("daily-main").length, 0);
});

test("previews an ad-hoc rule with an inline html sample and persists nothing", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/daily-main/layout-rules/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rule: cardRuleInput, html: cardPage([{ id: 1 }, { id: 2 }, { id: 3 }]) })
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.matched, true);
  assert.equal(preview.candidateCount, 3);
  assert.equal(archive.listCaptures("daily-main").length, 0);
});

test("previews a stored rule by id against a posted html page", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const rule = archive.createLayoutRule("daily-main", cardRuleInput);
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/daily-main/layout-rules/${rule.ruleId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: cardPage([{ id: 1 }, { id: 2 }])
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.ruleId, rule.ruleId);
  assert.equal(preview.candidateCount, 2);
});

test("activates a rule, then captures with it and records the rule revision", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const rule = archive.createLayoutRule("daily-main", cardRuleInput);
  const { base } = await start(t, archive);
  const activated = await fetch(`${base}/v1/feeds/daily-main/layout-rules/${rule.ruleId}/activate`, { method: "POST" });
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).rule.status, "active");

  const capture = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "text/html", "X-Captured-At": captureTime(1) },
    body: cardPage([{ id: 1 }, { id: 2 }, { id: 3 }])
  });
  assert.equal(capture.status, 202);
  const receipt = await capture.json();
  assert.equal(receipt.rule.ruleId, cardRuleInput.ruleId);
  assert.equal(receipt.rule.extractorStatus, "rule_matched");

  const runs = await (await fetch(`${base}/v1/feeds/daily-main/runs`)).json();
  assert.equal(runs.runs[0].ruleId, cardRuleInput.ruleId);
  assert.equal(runs.runs[0].ruleRevision, rule.revision);
});

test("deactivates the active rule and returns subsequent captures to legacy behaviour", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const rule = archive.createLayoutRule("daily-main", cardRuleInput);
  archive.activateLayoutRule("daily-main", rule.ruleId);
  const { base } = await start(t, archive);
  const deactivated = await fetch(`${base}/v1/feeds/daily-main/layout-rules/active/deactivate`, { method: "POST" });
  assert.equal(deactivated.status, 200);
  const body = await deactivated.json();
  assert.equal(body.withdrawn.ruleId, cardRuleInput.ruleId);

  const capture = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "text/html", "X-Captured-At": captureTime(2) },
    body: page(standardItems(4))
  });
  const receipt = await capture.json();
  assert.equal(receipt.rule.ruleId, "legacy-default");
});

test("layout endpoints 404 for an unknown feed instead of creating state", async (t) => {
  const { archive } = await makeArchive(t);
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/ghost/layout-rules`);
  assert.equal(response.status, 404);
});

test("the legacy snapshot and item contract is unchanged for a feed with no rules", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const { base } = await start(t, archive);
  const imported = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "text/html", "X-Captured-At": captureTime(1) },
    body: page(standardItems(4))
  });
  assert.equal(imported.status, 202);
  const receipt = await imported.json();
  assert.equal(receipt.candidateCount, 4);
  assert.equal(receipt.normalizedCount, 4);
  assert.equal(receipt.rule.ruleId, "legacy-default");
});
