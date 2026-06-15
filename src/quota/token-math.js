const {
  QUOTA_RATE_CARD_BASE_INPUT_CREDITS,
  CODEX_RATE_CARDS,
  DEFAULT_CODEX_RATE_CARD,
} = require("./constants");

function emptyTokenUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeTokenUsage(raw) {
  return {
    inputTokens: Number(raw?.input_tokens ?? raw?.inputTokens ?? 0),
    cachedInputTokens: Number(
      raw?.cached_input_tokens ?? raw?.cachedInputTokens ?? raw?.input_tokens_details?.cached_tokens ?? 0
    ),
    outputTokens: Number(raw?.output_tokens ?? raw?.outputTokens ?? 0),
    reasoningOutputTokens: Number(
      raw?.reasoning_output_tokens ?? raw?.reasoningOutputTokens ?? raw?.output_tokens_details?.reasoning_tokens ?? 0
    ),
    totalTokens: Number(raw?.total_tokens ?? raw?.totalTokens ?? 0),
  };
}

function addTokenUsage(total, usage) {
  total.inputTokens += Number(usage?.inputTokens ?? 0);
  total.cachedInputTokens += Number(usage?.cachedInputTokens ?? 0);
  total.outputTokens += Number(usage?.outputTokens ?? 0);
  total.reasoningOutputTokens += Number(usage?.reasoningOutputTokens ?? 0);
  total.totalTokens += Number(usage?.totalTokens ?? 0);
}

function subtractTokenUsage(later, earlier) {
  return {
    inputTokens: Math.max(0, Number(later?.inputTokens || 0) - Number(earlier?.inputTokens || 0)),
    outputTokens: Math.max(0, Number(later?.outputTokens || 0) - Number(earlier?.outputTokens || 0)),
    totalTokens: Math.max(0, Number(later?.totalTokens || 0) - Number(earlier?.totalTokens || 0)),
    cachedInputTokens: Math.max(0, Number(later?.cachedInputTokens || 0) - Number(earlier?.cachedInputTokens || 0)),
    reasoningOutputTokens: Math.max(
      0,
      Number(later?.reasoningOutputTokens || 0) - Number(earlier?.reasoningOutputTokens || 0)
    ),
  };
}

function tokenUsageTotal(usage) {
  const total = Number(usage?.totalTokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  const reasoning = Number(usage?.reasoningOutputTokens ?? 0);
  return Math.max(
    0,
    (Number.isFinite(input) ? input : 0) +
      (Number.isFinite(output) ? output : 0) +
      (Number.isFinite(reasoning) ? reasoning : 0)
  );
}

function codexRateCard(model) {
  const value = String(model || "").toLowerCase();
  return CODEX_RATE_CARDS.find((card) => card.pattern.test(value)) ?? DEFAULT_CODEX_RATE_CARD;
}

function quotaSpeedMultiplier(model, serviceTier = null) {
  const value = String(model || "").toLowerCase();
  const tier = String(serviceTier || "").toLowerCase();
  const isFast =
    /(^|[-_\s])fast($|[-_\s])|high[-_\s]?speed|speedy|turbo|accelerated/.test(value) ||
    tier === "fast" ||
    tier === "priority" ||
    tier === "turbo";
  return isFast ? codexRateCard(model).fastMultiplier : 1;
}

function weightedTokenUsage(usage, model, serviceTier = null) {
  const input = Math.max(0, Number.isFinite(Number(usage?.inputTokens)) ? Number(usage.inputTokens) : 0);
  const cachedInput = Math.max(
    0,
    Number.isFinite(Number(usage?.cachedInputTokens)) ? Number(usage.cachedInputTokens) : 0
  );
  const output = Math.max(0, Number.isFinite(Number(usage?.outputTokens)) ? Number(usage.outputTokens) : 0);
  const hasBreakdown = [input, cachedInput, output].some((value) => Number.isFinite(value) && value > 0);
  const effectiveCachedInput = Math.min(cachedInput, input);
  const uncachedInput = Math.max(0, input - effectiveCachedInput);
  const rateCard = codexRateCard(model);
  const total = hasBreakdown
    ? (uncachedInput * rateCard.input +
        effectiveCachedInput * rateCard.cachedInput +
        output * rateCard.output) /
      QUOTA_RATE_CARD_BASE_INPUT_CREDITS
    : tokenUsageTotal(usage);
  return total * quotaSpeedMultiplier(model, serviceTier);
}

function cloneTokenUsage(usage) {
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    cachedInputTokens: Number(usage?.cachedInputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    reasoningOutputTokens: Number(usage?.reasoningOutputTokens ?? 0),
    totalTokens: Number(usage?.totalTokens ?? 0),
  };
}

function dateMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizePlanType(planType) {
  const value = String(planType || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!value) return null;
  if (value.includes("business") || value.includes("team")) return "business";
  if (value.includes("enterprise")) return "enterprise";
  if (value.includes("teacher") || value.includes("health") || value.includes("gov") || value.includes("edu")) {
    return "enterprise";
  }
  if (value.includes("plus")) return "plus";
  if (value.includes("pro")) return "pro";
  if (value.includes("go")) return "go";
  if (value.includes("free")) return "free";
  return value;
}

function normalizePlanTypeLabel(planType) {
  return normalizePlanType(planType) || "unknown";
}

function rawUsedPercent(rateLimits, kind) {
  const window = kind === "weekly" ? rateLimits?.secondary : rateLimits?.primary;
  const value = Number(window?.used_percent ?? window?.usedPercent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function fallbackQuotaCreditUnitsPerPercent(planType, kind) {
  const plan = normalizePlanType(planType);
  if (kind === "weekly") {
    if (plan === "business" || plan === "enterprise") return 158000;
    if (plan === "plus") return 258000;
    return 100000;
  }
  if (plan === "business" || plan === "enterprise") return 29400;
  if (plan === "plus") return 43900;
  return 22000;
}

function fallbackQuotaCoefficient(planType, kind) {
  return 1 / fallbackQuotaCreditUnitsPerPercent(planType, kind);
}

function quotaCoefficientBounds(planType, kind) {
  const fallbackUnits = fallbackQuotaCreditUnitsPerPercent(planType, kind);
  const minUnits = kind === "weekly" ? 25000 : 8000;
  const maxUnits = kind === "weekly" ? 4000000 : 1500000;
  return {
    min: Math.min(1 / maxUnits, 1 / (fallbackUnits * 25)),
    max: Math.max(1 / minUnits, 25 / fallbackUnits),
  };
}

function isReasonableQuotaCoefficient(coefficient, planType, kind) {
  if (!Number.isFinite(coefficient) || coefficient <= 0) return false;
  const bounds = quotaCoefficientBounds(planType, kind);
  return coefficient >= bounds.min && coefficient <= bounds.max;
}

module.exports = {
  emptyTokenUsage,
  normalizeTokenUsage,
  addTokenUsage,
  subtractTokenUsage,
  tokenUsageTotal,
  codexRateCard,
  quotaSpeedMultiplier,
  weightedTokenUsage,
  cloneTokenUsage,
  dateMs,
  median,
  normalizePlanType,
  normalizePlanTypeLabel,
  rawUsedPercent,
  fallbackQuotaCreditUnitsPerPercent,
  fallbackQuotaCoefficient,
  quotaCoefficientBounds,
  isReasonableQuotaCoefficient,
};
