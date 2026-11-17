// Per-source layout adaptation rules.
//
// A layout rule describes *where* article links live on one particular page
// layout (the legacy rolling directory versus the newer card directory), and
// optionally which links inside that region are article links and how many
// usable items a healthy capture must contain. Rules are versioned per feed:
// operators create candidate rules, preview them against saved pages, and only
// then activate a revision. The legacy generic extractor remains the default
// until a feed activates an explicit rule, so existing callers keep their
// behaviour.

export const LEGACY_RULE_ID = "legacy-default";
export const RULE_STATUSES = new Set(["candidate", "active", "withdrawn"]);

const RULE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_SELECTOR_LENGTH = 300;
const MAX_PATTERN_LENGTH = 300;

export function validateRuleId(ruleId) {
  if (typeof ruleId !== "string" || !RULE_ID_PATTERN.test(ruleId)) {
    throw new TypeError("ruleId must be 1 to 64 safe letters, digits, dots, underscores or hyphens");
  }
}

export function validateRuleInput(input = {}) {
  if (typeof input !== "object" || input === null) throw new TypeError("layout rule must be an object");
  const ruleId = input.ruleId;
  validateRuleId(ruleId);
  if (ruleId === LEGACY_RULE_ID) {
    throw new TypeError(`ruleId ${LEGACY_RULE_ID} is reserved for the built-in generic extractor`);
  }
  const containerSelector = normalizeSelector(input.containerSelector, "containerSelector");
  const itemSelector = input.itemSelector === undefined || input.itemSelector === null
    ? null
    : normalizeSelector(input.itemSelector, "itemSelector");
  const linkPattern = input.linkPattern === undefined || input.linkPattern === null
    ? null
    : normalizePattern(input.linkPattern);
  const minimumItems = input.minimumItems === undefined || input.minimumItems === null
    ? null
    : normalizeMinimumItems(input.minimumItems);
  const note = input.note === undefined || input.note === null ? null : String(input.note).slice(0, 500);
  return { ruleId, containerSelector, itemSelector, linkPattern, minimumItems, note };
}

function normalizeSelector(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty selector string`);
  }
  const selector = value.trim();
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new RangeError(`${field} must not exceed ${MAX_SELECTOR_LENGTH} characters`);
  }
  // The offline parser only supports a single simple tag/#id/.class selector.
  // Reject anything that would silently be interpreted differently in a browser.
  if (!/^[a-zA-Z][\w-]*(?:[#.][\w-]+)?$|^[#.][\w-]+$/.test(selector)) {
    throw new TypeError(`${field} must be a simple tag, #id or .class selector`);
  }
  return selector;
}

function normalizePattern(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("linkPattern must be a non-empty regular expression string");
  }
  const pattern = value.trim();
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new RangeError(`linkPattern must not exceed ${MAX_PATTERN_LENGTH} characters`);
  }
  try {
    // Validate eagerly so a broken rule cannot be stored and fail every capture.
    new RegExp(pattern);
  } catch (error) {
    throw new TypeError(`linkPattern is not a valid regular expression: ${error.message}`);
  }
  return pattern;
}

function normalizeMinimumItems(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError("rule minimumItems must be between 1 and 10000");
  }
  return value;
}

// Parse the deliberately small supported selector subset into a matcher.
export function parseSelector(selector) {
  const text = selector.trim();
  const match = /^([a-zA-Z][\w-]*)?(?:([#.])([\w-]+))?$/.exec(text);
  if (!match) throw new TypeError(`unsupported selector: ${selector}`);
  const [, tag, marker, name] = match;
  if (!tag && !marker) throw new TypeError(`unsupported selector: ${selector}`);
  return {
    tag: tag ? tag.toLowerCase() : null,
    id: marker === "#" ? name : null,
    className: marker === "." ? name : null
  };
}

export function compileRule(rule) {
  const container = parseSelector(rule.containerSelector);
  const item = rule.itemSelector ? parseSelector(rule.itemSelector) : null;
  const linkPattern = rule.linkPattern ? new RegExp(rule.linkPattern) : null;
  return {
    ...rule,
    container,
    item,
    linkPattern,
    acceptsLink(href) {
      if (!linkPattern) return true;
      return linkPattern.test(href);
    }
  };
}

// A frozen description of the configuration a single capture must be explained
// with. Resolving it once and carrying it through the whole import means a rule
// switch while a response is in flight cannot mix two rule revisions or their
// quality water levels.
export function resolveCaptureContext(feed, activeRule) {
  const effectiveMinimumItems = activeRule?.minimumItems ?? feed.minimumItems;
  const context = {
    feedId: feed.feedId,
    baseUrl: feed.baseUrl,
    allowedHosts: [...feed.allowedHosts],
    missingThreshold: feed.missingThreshold,
    minimumItems: effectiveMinimumItems,
    rule: activeRule ? freezeRule(activeRule) : null,
    ruleId: activeRule ? activeRule.ruleId : LEGACY_RULE_ID,
    ruleRevision: activeRule ? activeRule.revision : null
  };
  return Object.freeze(context);
}

function freezeRule(rule) {
  return Object.freeze({ ...rule });
}

export function mapRuleRow(row) {
  return {
    rowId: row.rule_id,
    feedId: row.feed_id,
    ruleId: row.rule_key,
    revision: row.revision,
    status: row.status,
    containerSelector: row.container_selector,
    itemSelector: row.item_selector,
    linkPattern: row.link_pattern,
    minimumItems: row.minimum_items,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
