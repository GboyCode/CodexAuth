const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const {
  normalizeTokenUsage,
  subtractTokenUsage,
  weightedTokenUsage,
  normalizePlanTypeLabel,
  rawUsedPercent,
  fallbackQuotaCoefficient,
  isReasonableQuotaCoefficient,
  median,
  dateMs,
} = require("../src/quota/token-math");

const sessionsRoot = process.argv[2] || path.join(os.homedir(), ".codex", "sessions");

assert.ok(Number.isFinite(fallbackQuotaCoefficient("plus", "session")));
assert.ok(Number.isFinite(fallbackQuotaCoefficient("team", "weekly")));
assert.equal(fallbackQuotaCoefficient("pro", "session"), null);
assert.equal(fallbackQuotaCoefficient("enterprise", "weekly"), null);
assert.equal(fallbackQuotaCoefficient("free", "session"), null);

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
        planType: normalizePlanTypeLabel(entry.payload.rate_limits.plan_type),
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
    if (Number.isFinite(coeff)) {
      const error = Math.abs(coeff * sample.weightedTokens - sample.percentDelta);
      errors.push(error);
      if (!errorsByPlan.has(plan)) errorsByPlan.set(plan, []);
      errorsByPlan.get(plan).push(error);
    }
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
