const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const sessionsRoot = process.argv[2] || path.join(os.homedir(), ".codex", "sessions");
const QUOTA_RATE_CARD_BASE_INPUT_CREDITS = 125;
const CODEX_RATE_CARDS = [
  { pattern: /gpt[-_\s]?5\.5/, input: 125, cachedInput: 12.5, output: 750, fastMultiplier: 2.5 },
  { pattern: /gpt[-_\s]?5\.4[-_\s]?mini/, input: 18.75, cachedInput: 1.875, output: 113, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5\.4/, input: 62.5, cachedInput: 6.25, output: 375, fastMultiplier: 2 },
  { pattern: /gpt[-_\s]?5\.3[-_\s]?codex/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5\.2/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5[-_\s]?codex/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
];
const DEFAULT_CODEX_RATE_CARD = CODEX_RATE_CARDS[0];

function dateMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizePlanType(planType) {
  const value = String(planType || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!value) return "unknown";
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

function normalizeTokenUsage(raw) {
  return {
    inputTokens: Number(raw?.input_tokens ?? raw?.inputTokens ?? 0),
    outputTokens: Number(raw?.output_tokens ?? raw?.outputTokens ?? 0),
    totalTokens: Number(raw?.total_tokens ?? raw?.totalTokens ?? 0),
    cachedInputTokens: Number(
      raw?.cached_input_tokens ?? raw?.cachedInputTokens ?? raw?.input_tokens_details?.cached_tokens ?? 0
    ),
    reasoningOutputTokens: Number(
      raw?.reasoning_output_tokens ?? raw?.reasoningOutputTokens ?? raw?.output_tokens_details?.reasoning_tokens ?? 0
    ),
  };
}

function tokenUsageTotal(usage) {
  const total = Number(usage?.totalTokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  return Math.max(
    0,
    Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0) + Number(usage?.reasoningOutputTokens ?? 0)
  );
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

function rawUsedPercent(rateLimits, kind) {
  const window = kind === "weekly" ? rateLimits?.secondary : rateLimits?.primary;
  const value = Number(window?.used_percent);
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

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function walkRollouts(root) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(full);
        files.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(root);
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function parseFile(file) {
  const events = [];
  let sessionId = null;
  let model = null;
  let serviceTier = null;
  const stream = fs.createReadStream(file.path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id ?? sessionId;
    } else if (entry.type === "turn_context") {
      model = entry.payload?.model ?? model;
      serviceTier =
        entry.payload?.service_tier ??
        entry.payload?.serviceTier ??
        entry.payload?.collaboration_mode?.settings?.service_tier ??
        serviceTier;
    } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
      const timestamp = entry.timestamp ?? new Date(file.mtimeMs).toISOString();
      const ms = dateMs(timestamp);
      if (!Number.isFinite(ms) || !entry.payload?.rate_limits) continue;
      const info = entry.payload?.info ?? {};
      events.push({
        sessionId: sessionId ?? file.path,
        timestamp,
        ms,
        model,
        serviceTier,
        planType: normalizePlanType(entry.payload.rate_limits.plan_type),
        tokenUsage: normalizeTokenUsage(info.total_token_usage ?? info.totalTokenUsage),
        rateLimits: entry.payload.rate_limits,
      });
    }
  }
  return events;
}

function collectSamples(events) {
  const bySession = new Map();
  for (const event of events) {
    if (!bySession.has(event.sessionId)) bySession.set(event.sessionId, []);
    bySession.get(event.sessionId).push(event);
  }
  const samples = [];
  for (const sessionEvents of bySession.values()) {
    sessionEvents.sort((a, b) => a.ms - b.ms);
    const trackers = {
      session: { lastChangeEvent: null },
      weekly: { lastChangeEvent: null },
    };
    for (const event of sessionEvents) {
      for (const kind of ["session", "weekly"]) {
        const tracker = trackers[kind];
        const current = rawUsedPercent(event.rateLimits, kind);
        if (!Number.isFinite(current)) continue;

        if (!tracker.lastChangeEvent) {
          tracker.lastChangeEvent = event;
          continue;
        }

        const previous = rawUsedPercent(tracker.lastChangeEvent.rateLimits, kind);
        if (!Number.isFinite(previous)) {
          tracker.lastChangeEvent = event;
          continue;
        }
        if (current === previous) continue;

        const deltaUsage = subtractTokenUsage(event.tokenUsage, tracker.lastChangeEvent.tokenUsage);
        const weightedTokens = weightedTokenUsage(
          deltaUsage,
          event.model || tracker.lastChangeEvent.model,
          event.serviceTier || tracker.lastChangeEvent.serviceTier
        );
        const percentDelta = current - previous;
        const coefficient = percentDelta / weightedTokens;
        if (
          percentDelta > 0 &&
          percentDelta <= 40 &&
          weightedTokens >= 1000 &&
          isReasonableQuotaCoefficient(coefficient, event.planType, kind)
        ) {
          samples.push({
            kind,
            planType: event.planType,
            ms: event.ms,
            weightedTokens,
            percentDelta,
            coefficient,
          });
        }
        tracker.lastChangeEvent = event;
      }
    }
  }
  return samples.sort((a, b) => a.ms - b.ms);
}

function validateKind(samples, kind) {
  const kindSamples = samples.filter((sample) => sample.kind === kind);
  const coefficientsByPlan = new Map();
  const errorsByPlan = new Map();
  const errors = [];
  for (const sample of kindSamples) {
    const plan = sample.planType || "unknown";
    const coefficients = coefficientsByPlan.get(plan) ?? [];
    const coeff = median(coefficients) ?? fallbackQuotaCoefficient(plan, kind);
    const error = Math.abs(coeff * sample.weightedTokens - sample.percentDelta);
    errors.push(error);
    if (!errorsByPlan.has(plan)) errorsByPlan.set(plan, []);
    errorsByPlan.get(plan).push(error);
    coefficients.push(sample.coefficient);
    coefficientsByPlan.set(plan, coefficients);
  }
  const byPlan = {};
  for (const plan of Array.from(new Set(kindSamples.map((sample) => sample.planType || "unknown"))).sort()) {
    const planSamples = kindSamples.filter((sample) => (sample.planType || "unknown") === plan);
    byPlan[plan] = {
      samples: planSamples.length,
      medianCreditUnitsPerPercent: median(planSamples.map((sample) => sample.weightedTokens / sample.percentDelta)),
      p90AbsError: percentile(errorsByPlan.get(plan) ?? [], 90),
    };
  }
  return {
    samples: kindSamples.length,
    medianCreditUnitsPerPercent: median(kindSamples.map((sample) => sample.weightedTokens / sample.percentDelta)),
    replayed: errors.length,
    p50AbsError: percentile(errors, 50),
    p90AbsError: percentile(errors, 90),
    byPlan,
  };
}

async function main() {
  const files = walkRollouts(sessionsRoot);
  const events = [];
  for (const file of files) {
    events.push(...(await parseFile(file)));
  }
  const samples = collectSamples(events);
  const report = {
    sessionsRoot,
    files: files.length,
    events: events.length,
    session: validateKind(samples, "session"),
    weekly: validateKind(samples, "weekly"),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
