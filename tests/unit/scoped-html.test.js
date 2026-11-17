import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks, extractScopedLinks } from "../../src/feed/html.js";
import { compileRule } from "../../src/feed/layout-rule.js";

const base = "https://news.example.test/scroll-news/news1.html";
const rule = (overrides = {}) => compileRule({
  containerSelector: "#card-feed",
  itemSelector: ".news-card",
  linkPattern: null,
  ...overrides
});

const pageWithNav = `<html><body><nav><a href="/about.shtml">关于</a><a href="/index.shtml">首页</a></nav>
<section id="card-feed">
<div class="news-card"><a href="/cards/2026/a.shtml">卡片A</a></div>
<div class="news-card"><a href="/cards/2026/b.shtml">卡片B</a></div>
</section></body></html>`;

test("scoped extraction ignores navigation anchors and keeps only the rule region", () => {
  const result = extractScopedLinks(pageWithNav, base, rule());
  assert.equal(result.matched, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.candidates.map((c) => c.title), ["卡片A", "卡片B"]);
  assert.ok(result.candidates.every((c) => c.href.includes("/cards/")));
});

test("legacy extraction still counts the navigation links for unchanged callers", () => {
  const legacy = extractLinks(pageWithNav, base);
  assert.equal(legacy.length, 4);
  assert.equal(legacy[0].href, "https://news.example.test/about.shtml");
});

test("reports an explainable miss when the configured container is absent", () => {
  const result = extractScopedLinks("<html><body><p>改版了</p></body></html>", base, rule());
  assert.equal(result.matched, false);
  assert.equal(result.candidates.length, 0);
  assert.match(result.reason, /^layout_container_not_found:#card-feed$/);
});

test("reports no article links rather than treating an empty region as a full list", () => {
  const result = extractScopedLinks('<section id="card-feed"></section>', base, rule());
  assert.equal(result.matched, true);
  assert.equal(result.candidates.length, 0);
  assert.match(result.reason, /^layout_no_article_links:#card-feed$/);
});

test("an item selector restricts collection to repeated item elements", () => {
  const html = `<section id="card-feed"><a href="/cards/lead.shtml">主推</a>
  <div class="news-card"><a href="/cards/inside.shtml">卡片内</a></div></section>`;
  const scoped = extractScopedLinks(html, base, rule());
  assert.deepEqual(scoped.candidates.map((c) => c.title), ["卡片内"]);
  const withoutItem = extractScopedLinks(html, base, rule({ itemSelector: null }));
  assert.equal(withoutItem.candidates.length, 2);
});

test("a link pattern filters anchors inside the region", () => {
  const result = extractScopedLinks(pageWithNav, base, rule({ itemSelector: null, linkPattern: "/cards/" }));
  assert.ok(result.candidates.every((c) => c.href.includes("/cards/")));
  assert.equal(result.candidates.length, 2);
});

test("associates the nearest preceding time inside the scope", () => {
  const html = `<section id="card-feed"><div class="news-card">
  <time datetime="2026-11-16T10:00:00+08:00">10:00</time><a href="/cards/t.shtml">定时</a>
  </div></section>`;
  const [candidate] = extractScopedLinks(html, base, rule({ itemSelector: null })).candidates;
  assert.equal(candidate.publishedAt, "2026-11-16T10:00:00+08:00");
});

test("handles a container that wraps the whole document and closes normally", () => {
  const html = `<main id="card-feed"><div class="news-card"><a href="/cards/x.shtml">X</a></div></main>`;
  const result = extractScopedLinks(html, base, rule());
  assert.equal(result.matched, true);
  assert.equal(result.candidates.length, 1);
});

test("validates capture size and type the same way as the legacy extractor", () => {
  assert.throws(() => extractScopedLinks("", base, rule()), /non-empty/);
  assert.throws(() => extractScopedLinks("x".repeat(5_000_001), base, rule()), /5 MB/);
});
