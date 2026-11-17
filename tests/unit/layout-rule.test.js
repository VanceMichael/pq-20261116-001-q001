import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRuleInput, parseSelector, compileRule, resolveCaptureContext,
  LEGACY_RULE_ID
} from "../../src/feed/layout-rule.js";

test("accepts a well-formed rule with id, class and tag selectors", () => {
  const rule = validateRuleInput({
    ruleId: "card-v1", containerSelector: "section#card-feed",
    itemSelector: "div.news-card", linkPattern: "/cards/", minimumItems: 4
  });
  assert.equal(rule.containerSelector, "section#card-feed");
  assert.equal(rule.itemSelector, "div.news-card");
  assert.equal(rule.minimumItems, 4);
});

test("defaults optional item selector, pattern and minimum to null", () => {
  const rule = validateRuleInput({ ruleId: "simple", containerSelector: "#list" });
  assert.equal(rule.itemSelector, null);
  assert.equal(rule.linkPattern, null);
  assert.equal(rule.minimumItems, null);
});

test("rejects reserved legacy rule id and malformed identifiers", () => {
  assert.throws(() => validateRuleInput({ ruleId: LEGACY_RULE_ID, containerSelector: "#x" }), /reserved/);
  assert.throws(() => validateRuleInput({ ruleId: "bad/id", containerSelector: "#x" }), /ruleId/);
  assert.throws(() => validateRuleInput({ ruleId: "", containerSelector: "#x" }), /ruleId/);
});

test("rejects unsupported selector shapes instead of silently misparsing them", () => {
  assert.throws(() => validateRuleInput({ ruleId: "r", containerSelector: "#a .b" }), /simple tag/);
  assert.throws(() => validateRuleInput({ ruleId: "r", containerSelector: "" }), /containerSelector/);
  assert.throws(() => validateRuleInput({ ruleId: "r", containerSelector: "[data-x]" }), /simple tag/);
});

test("rejects a broken regular expression before it can be stored", () => {
  assert.throws(
    () => validateRuleInput({ ruleId: "r", containerSelector: "#x", linkPattern: "(/unclosed" }),
    /regular expression/
  );
});

test("rejects out-of-range rule minimum item counts", () => {
  assert.throws(() => validateRuleInput({ ruleId: "r", containerSelector: "#x", minimumItems: 0 }), /minimumItems/);
  assert.throws(() => validateRuleInput({ ruleId: "r", containerSelector: "#x", minimumItems: 10001 }), /minimumItems/);
});

test("parses every supported selector shape into an explicit matcher", () => {
  assert.deepEqual(parseSelector("main"), { tag: "main", id: null, className: null });
  assert.deepEqual(parseSelector("#news-list"), { tag: null, id: "news-list", className: null });
  assert.deepEqual(parseSelector(".news-card"), { tag: null, id: null, className: "news-card" });
  assert.deepEqual(parseSelector("section#card-feed"), { tag: "section", id: "card-feed", className: null });
  assert.deepEqual(parseSelector("div.news-card"), { tag: "div", id: null, className: "news-card" });
});

test("compiles a link pattern that only admits matching hrefs", () => {
  const rule = compileRule({ containerSelector: "#x", itemSelector: null, linkPattern: "/cards/" });
  assert.equal(rule.acceptsLink("https://h.test/cards/a.shtml"), true);
  assert.equal(rule.acceptsLink("https://h.test/about.shtml"), false);
});

test("capture context freezes the active rule and its quality water level", () => {
  const feed = { feedId: "f", baseUrl: "https://h.test/", allowedHosts: ["h.test"], minimumItems: 3, missingThreshold: 3 };
  const rule = { ruleId: "card", revision: 2, minimumItems: 7, containerSelector: "#x" };
  const context = resolveCaptureContext(feed, rule);
  assert.equal(context.ruleId, "card");
  assert.equal(context.ruleRevision, 2);
  assert.equal(context.minimumItems, 7);
  assert.throws(() => { context.minimumItems = 99; }, /frozen|read.only|object is not extensible/);
});

test("capture context falls back to the feed minimum and legacy rule id without a rule", () => {
  const feed = { feedId: "f", baseUrl: "https://h.test/", allowedHosts: [], minimumItems: 5, missingThreshold: 2 };
  const context = resolveCaptureContext(feed, null);
  assert.equal(context.ruleId, LEGACY_RULE_ID);
  assert.equal(context.ruleRevision, null);
  assert.equal(context.minimumItems, 5);
});
