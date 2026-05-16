const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const sessionsRoot = process.argv[2] || path.join(os.homedir(), ".codex", "sessions");

function dateMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeTokenUsage(raw) {
  return {
    inputTokens: Number(raw?.input_tokens ?? raw?.inputTokens ?? 0),
    outputTokens: Number(raw?.output_tokens ?? raw?.outputTokens ?? 0),
    totalTokens: Number(raw?.total_tokens ?? raw?.totalTokens ?? 0),
    cachedInputTokens: Number(raw?.cached_input_tokens ?? raw?.cachedInputTokens ?? 0),
    reasoningOutputTokens: Number(raw?.reasoning_output_tokens ?? raw?.reasoningOutputTokens ?? 0),
  };
}

function tokenUsageTotal(usage) {
  const total = Number(usage?.totalTokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  return Math.max(0, Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0));
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

function modelQuotaMultiplier(model) {
  const value = String(model || "").toLowerCase();
  return /(^|[-_\s])fast($|[-_\s])|high[-_\s]?speed|speedy/.test(value) ? 1.5 : 1;
}

function weightedTokenUsage(usage, model) {
  return tokenUsageTotal(usage) * modelQuotaMultiplier(model);
}

function rawUsedPercent(rateLimits, kind) {
  const window = kind === "weekly" ? rateLimits?.secondary : rateLimits?.primary;
  const value = Number(window?.used_percent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
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
      session: { lastChangeEvent: null, maxTokensSinceChange: null },
      weekly: { lastChangeEvent: null, maxTokensSinceChange: null },
    };
    for (const event of sessionEvents) {
      for (const kind of ["session", "weekly"]) {
        const tracker = trackers[kind];
        const current = rawUsedPercent(event.rateLimits, kind);
        if (!Number.isFinite(current)) continue;

        if (!tracker.lastChangeEvent) {
          tracker.lastChangeEvent = event;
          tracker.maxTokensSinceChange = event;
          continue;
        }

        const previous = rawUsedPercent(tracker.lastChangeEvent.rateLimits, kind);
        if (!Number.isFinite(previous)) continue;
        if (current === previous) {
          if (tokenUsageTotal(event.tokenUsage) > tokenUsageTotal(tracker.maxTokensSinceChange.tokenUsage)) {
            tracker.maxTokensSinceChange = event;
          }
          continue;
        }

        const referenceEvent = tracker.maxTokensSinceChange || tracker.lastChangeEvent;
        const deltaUsage = subtractTokenUsage(referenceEvent.tokenUsage, tracker.lastChangeEvent.tokenUsage);
        const weightedTokens = weightedTokenUsage(deltaUsage, event.model || tracker.lastChangeEvent.model);
        const percentDelta = current - previous;
        if (percentDelta > 0 && percentDelta <= 40 && weightedTokens >= 1000) {
          samples.push({
            kind,
            ms: event.ms,
            weightedTokens,
            percentDelta,
            coefficient: percentDelta / weightedTokens,
          });
        }
        tracker.lastChangeEvent = event;
        tracker.maxTokensSinceChange = event;
      }
    }
  }
  return samples.sort((a, b) => a.ms - b.ms);
}

function validateKind(samples, kind) {
  const kindSamples = samples.filter((sample) => sample.kind === kind);
  const coefficients = [];
  const errors = [];
  for (const sample of kindSamples) {
    const coeff = median(coefficients);
    if (coeff) {
      errors.push(Math.abs(coeff * sample.weightedTokens - sample.percentDelta));
    }
    coefficients.push(sample.coefficient);
  }
  return {
    samples: kindSamples.length,
    medianTokensPerPercent: median(kindSamples.map((sample) => 1 / sample.coefficient)),
    replayed: errors.length,
    p50AbsError: percentile(errors, 50),
    p90AbsError: percentile(errors, 90),
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
