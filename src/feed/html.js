const ENTITY_MAP = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'],
  ["apos", "'"], ["nbsp", " "], ["mdash", "—"], ["hellip", "…"]
]);

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : "�";
    }
    return ENTITY_MAP.get(entity.toLowerCase()) ?? match;
  });
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const key = match[1].toLowerCase();
    if (!(key in attributes)) attributes[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function textContent(value) {
  return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\s]+/g, " ")).trim();
}

function looksLikeArticleUrl(value) {
  return /\.(?:s?html?)(?:[?#].*)?$/i.test(value) || /\/news\d{5,}(?:[/?#]|$)/i.test(value);
}

function validateHtml(html) {
  if (typeof html !== "string" || html.length === 0) throw new TypeError("HTML must be a non-empty string");
  if (html.length > 5_000_000) throw new RangeError("HTML capture exceeds 5 MB");
}

function resolveHref(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

// Legacy generic extractor: every article-looking anchor in the whole document.
// Its behaviour is part of the public default and must stay unchanged for feeds
// that have not activated an explicit layout rule.
export function extractLinks(html, baseUrl) {
  validateHtml(html);
  const tokens = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
  const found = [];
  let active = null;
  let lastTime = null;
  let token;
  while ((token = tokens.exec(html))) {
    const raw = token[0];
    if (raw.startsWith("<!--")) continue;
    if (raw[0] !== "<") {
      if (active) active.text += raw;
      continue;
    }
    const closing = /^<\s*\//.test(raw);
    const nameMatch = raw.match(/^<\s*\/?\s*([a-z][\w:-]*)/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      if (name === "a" && active) {
        const title = textContent(active.text);
        const href = active.href.trim();
        if (title && href && looksLikeArticleUrl(href)) {
          found.push({ href, title, publishedAt: active.publishedAt ?? lastTime });
        }
        active = null;
      }
      continue;
    }
    const attributes = parseAttributes(raw.slice(nameMatch[0].length, raw.length - 1));
    if (name === "script" || name === "style") {
      const rawTextEnd = new RegExp(`<\\/\\s*${name}\\s*>`, "ig");
      rawTextEnd.lastIndex = tokens.lastIndex;
      const closingTag = rawTextEnd.exec(html);
      if (closingTag) tokens.lastIndex = rawTextEnd.lastIndex;
      continue;
    }
    if (name === "time") lastTime = attributes.datetime ?? lastTime;
    if (name === "a") {
      if (active) active = null;
      active = { href: attributes.href ?? "", text: "", publishedAt: lastTime };
    }
    if (name === "br" && active) active.text += " ";
  }
  if (active) {
    const title = textContent(active.text);
    if (title && active.href && looksLikeArticleUrl(active.href)) {
      found.push({ href: active.href.trim(), title, publishedAt: active.publishedAt ?? lastTime });
    }
  }
  return found.map((item) => {
    const resolved = resolveHref(item.href, baseUrl);
    return resolved ? { ...item, href: resolved } : item;
  });
}

function describeElement(name, attributes) {
  return {
    name,
    id: attributes.id ?? null,
    classNames: typeof attributes.class === "string" && attributes.class.length > 0
      ? attributes.class.trim().split(/\s+/).filter(Boolean)
      : []
  };
}

// Rule-aware extractor. Only anchors inside the rule's container (and, when
// configured, inside an item element) are considered, so page chrome such as
// navigation bars can never be mistaken for the article list. When the
// container is absent or contains no qualifying anchors the extractor returns
// an explicit, explainable outcome instead of silently falling back.
export function extractScopedLinks(html, baseUrl, compiledRule) {
  validateHtml(html);
  const tokens = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
  const stack = [];
  let scopeElement = null;
  let itemElement = null;
  let scopeMatched = false;
  let scopeTime = null;
  let active = null;
  let token;
  const found = [];

  const inScope = () => scopeElement !== null;
  const inItem = () => !compiledRule.item || itemElement !== null;
  const collecting = () => inScope() && inItem();

  const pushFound = (anchor) => {
    const title = textContent(anchor.text);
    const rawHref = anchor.href.trim();
    if (!title || !rawHref) return;
    const resolved = resolveHref(rawHref, baseUrl);
    const href = resolved ?? rawHref;
    if (!compiledRule.acceptsLink(href)) return;
    found.push({ href, title, publishedAt: anchor.publishedAt ?? scopeTime });
  };

  while ((token = tokens.exec(html))) {
    const raw = token[0];
    if (raw.startsWith("<!--")) continue;
    if (raw[0] !== "<") {
      if (active) active.text += raw;
      continue;
    }
    const closing = /^<\s*\//.test(raw);
    const nameMatch = raw.match(/^<\s*\/?\s*([a-z][\w:-]*)/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      if (name === "a") {
        // Only an anchor that began inside a collectible region is finalized;
        // anchors outside any item must not clobber a later real candidate.
        if (active && active.collectible) {
          const anchor = active;
          active = null;
          pushFound(anchor);
        } else {
          active = null;
        }
        continue;
      }
      if (stack.length > 0) {
        const popped = stack.pop();
        if (popped === itemElement) itemElement = null;
        if (popped === scopeElement) {
          scopeElement = null;
          scopeTime = null;
        }
      }
      continue;
    }
    const attributes = parseAttributes(raw.slice(nameMatch[0].length, raw.length - 1));
    if (name === "script" || name === "style") {
      const rawTextEnd = new RegExp(`<\\/\\s*${name}\\s*>`, "ig");
      rawTextEnd.lastIndex = tokens.lastIndex;
      const closingTag = rawTextEnd.exec(html);
      if (closingTag) tokens.lastIndex = rawTextEnd.lastIndex;
      continue;
    }
    if (name === "time" && inScope()) {
      scopeTime = attributes.datetime ?? scopeTime;
      if (active) active.publishedAt = scopeTime;
    }
    if (name === "br") {
      if (active) active.text += " ";
      continue;
    }
    if (VOID_TAGS.has(name)) continue;
    const element = describeElement(name, attributes);
    const isAnchor = name === "a";
    if (!isAnchor) stack.push(element);
    if (scopeElement === null && selectorElementMatches(compiledRule.container, element)) {
      scopeElement = element;
      scopeMatched = true;
      scopeTime = null;
    }
    if (inScope() && compiledRule.item && itemElement === null
      && selectorElementMatches(compiledRule.item, element)) {
      itemElement = element;
    }
    // Anchors are not structural stack frames, but they must only start
    // collecting after the enclosing scope/item above has been recorded.
    if (isAnchor) {
      if (collecting()) {
        if (active) active = null;
        active = { href: attributes.href ?? "", text: "", publishedAt: scopeTime, collectible: true };
      }
      continue;
    }
  }
  if (active) pushFound(active);

  if (!scopeMatched) {
    return {
      matched: false,
      reason: `layout_container_not_found:${compiledRule.containerSelector}`,
      candidates: []
    };
  }
  return {
    matched: true,
    reason: found.length === 0 ? `layout_no_article_links:${compiledRule.containerSelector}` : null,
    candidates: found
  };
}

function selectorElementMatches(parsedSelector, element) {
  if (parsedSelector.tag && parsedSelector.tag !== element.name) return false;
  if (parsedSelector.id && parsedSelector.id !== element.id) return false;
  if (parsedSelector.className && !element.classNames.includes(parsedSelector.className)) return false;
  return true;
}

export function pageFingerprint(html) {
  return createHashForContent(html);
}

function createHashForContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

import { createHash } from "node:crypto";
