import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NewsArchive } from "../src/service/archive.js";

export const fixturePath = fileURLToPath(new URL("../fixtures/rolling-feed.html", import.meta.url));

export async function makeArchive(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-test-"));
  const filename = join(directory, "archive.sqlite");
  const archive = new NewsArchive(filename, options);
  t.after(() => {
    archive.close();
    return rm(directory, { recursive: true, force: true });
  });
  return { archive, directory, filename };
}

export async function fixtureHtml() {
  return readFile(fixturePath, "utf8");
}

export function page(items, { wrapper = "main", titlePrefix = "标题" } = {}) {
  const entries = items.map((item, index) => {
    const url = item.url ?? `/2026/11-16/article-${item.id}.shtml`;
    const title = item.title ?? `${titlePrefix}${item.id}`;
    const time = item.time ?? `2026-11-16T10:${String(index).padStart(2, "0")}:00+08:00`;
    return `<article><time datetime="${time}">${index}</time><a href="${url}">${title}</a></article>`;
  }).join("\n");
  return `<!doctype html><html><body><${wrapper} id="news-list">${entries}</${wrapper}></body></html>`;
}

export function standardItems(count = 4, start = 1) {
  return Array.from({ length: count }, (_, offset) => ({ id: start + offset }));
}

export const baseFeed = {
  feedId: "daily-main",
  baseUrl: "https://news.example.test/scroll-news/news1.html",
  allowedHosts: ["news.example.test"],
  minimumItems: 3,
  missingThreshold: 3
};

export function captureTime(second) {
  return `2026-11-16T02:00:${String(second).padStart(2, "0")}.000Z`;
}

// A fetcher whose response order and timing are fully controlled by the test.
// Each queued entry is returned on successive calls; a gate lets a test hold a
// response in flight while it switches the layout rule, then release it.
export function queuedFetcher(entries = []) {
  const queue = [...entries];
  const calls = [];
  let gate = null;
  return {
    enqueue(...items) {
      queue.push(...items);
    },
    setGate(promise) {
      gate = promise;
    },
    calls,
    count: () => calls.length,
    async fetchFeed(feed) {
      const entry = queue.shift();
      calls.push({ feedId: feed.feedId, baseUrl: feed.baseUrl });
      if (gate) await gate;
      if (entry instanceof Error) throw entry;
      return {
        status: entry.status ?? 200,
        html: entry.html ?? null,
        requestedUrl: feed.baseUrl,
        finalUrl: entry.finalUrl ?? feed.baseUrl,
        attemptCount: entry.attemptCount ?? 1
      };
    }
  };
}

export function cardPage(items, { container = "card-feed", itemClass = "news-card" } = {}) {
  const cards = items.map((item, index) => {
    const url = item.url ?? `/cards/2026/11-16/card-${item.id}.shtml`;
    const title = item.title ?? `卡片${item.id}`;
    const time = item.time ?? `2026-11-16T10:${String(index).padStart(2, "0")}:00+08:00`;
    return `<div class="${itemClass}"><time datetime="${time}">${index}</time><a href="${url}">${title}</a></div>`;
  }).join("\n");
  return `<!doctype html><html><body><nav><a href="/about.shtml">关于</a></nav>
    <section id="${container}">${cards}</section></body></html>`;
}

export const cardRuleInput = {
  ruleId: "card-directory-v1",
  containerSelector: "#card-feed",
  itemSelector: ".news-card",
  linkPattern: null,
  minimumItems: 3,
  note: "新版卡片目录版式"
};
