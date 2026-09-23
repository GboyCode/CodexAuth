const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { normalizeTokenUsage, emptyTokenUsage, addTokenUsage, subtractTokenUsage, tokenUsageTotal } = require("./token-math");

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function limitId(raw) { return String(raw?.limit_id ?? raw?.limitId ?? "codex"); }
function windowMinutes(raw) {
  return numberOrNull(raw?.window_minutes ?? raw?.windowDurationMins ?? raw?.windowMinutes) ??
    (numberOrNull(raw?.limit_window_seconds) === null ? null : Number(raw.limit_window_seconds) / 60);
}
function windowFor(raw, kind) {
  const primary = raw?.primary;
  const secondary = raw?.secondary;
  // Weekly-only plans put the week in primary. Unknown spans keep their slot.
  const windows = [primary, secondary].filter(Boolean);
  const weekly = windows.find((w) => windowMinutes(w) >= 10080) ?? null;
  if (kind === "weekly") return weekly ?? (windowMinutes(secondary) === null ? secondary : null);
  return windows.find((w) => { const n = windowMinutes(w); return n !== null && n < 10080; }) ??
    (windowMinutes(primary) === null ? primary : null);
}
function normalizeWindow(raw, checkedAt) {
  if (!raw) return null;
  const used = numberOrNull(raw.used_percent ?? raw.usedPercent);
  const minutes = windowMinutes(raw);
  const resetsAt = numberOrNull(raw.resets_at ?? raw.resetsAt);
  if (minutes !== null && minutes <= 0) return null;
  if (used === null && minutes === null && resetsAt === null) return null;
  return { usedPercent: used === null ? null : Math.max(0, Math.min(100, used)), windowMinutes: minutes, resetsAt, checkedAt, estimateBaseAt: checkedAt };
}
function normalizeResetCredits(raw, checkedAt) {
  const count = numberOrNull(raw?.availableCount ?? raw?.available_count);
  if (!Number.isInteger(count) || count < 0) return null;
  const credits = Array.isArray(raw.credits) ? raw.credits.map((c) => ({
    expiresAt: numberOrNull(c.expiresAt ?? c.expires_at), status: typeof c.status === "string" ? c.status : null,
  })) : null;
  return { availableCount: count, credits, checkedAt, source: "local" };
}
function normalizeBucket(raw, checkedAt) {
  if (!raw) return null;
  const credits = raw.credits;
  return {
    source: "local", checkedAt, limitId: limitId(raw),
    label: String(raw.limit_name ?? raw.limitName ?? limitId(raw)).slice(0, 120),
    planType: raw.plan_type ?? raw.planType ?? null,
    session: normalizeWindow(windowFor(raw, "session"), checkedAt),
    weekly: normalizeWindow(windowFor(raw, "weekly"), checkedAt),
    credits: credits ? { hasCredits: credits.has_credits ?? credits.hasCredits ?? null, unlimited: credits.unlimited ?? null, balance: credits.balance ?? null } : null,
    resetCredits: normalizeResetCredits(raw.rateLimitResetCredits ?? raw.rate_limit_reset_credits, checkedAt),
    error: null,
  };
}
function combineBuckets(buckets) {
  const byId = new Map();
  for (const bucket of buckets.filter(Boolean)) {
    for (const b of [bucket, ...(bucket.additional ?? [])]) {
      if (!b.limitId) continue;
      const prev = byId.get(b.limitId);
      if (!prev || Date.parse(b.checkedAt) >= Date.parse(prev.checkedAt)) byId.set(b.limitId, b);
    }
  }
  const main = byId.get("codex") ?? [...byId.values()].sort((a,b) => Date.parse(b.checkedAt)-Date.parse(a.checkedAt))[0];
  if (!main) return null;
  return { ...main, additional: [...byId.values()].filter((b) => b.limitId !== main.limitId).map(({additional, ...b}) => b) };
}

function bucketsFromRecord(payload) {
  const raw = payload?.rate_limits ?? payload?.rateLimits;
  const map = payload?.rateLimitsByLimitId ?? payload?.rate_limits_by_limit_id;
  if (map && typeof map === "object" && !Array.isArray(map)) return Object.entries(map).map(([id,b]) => ({...b, limit_id:id}));
  return raw && typeof raw === "object" ? [raw] : [];
}

function createRecordState(previous) {
  if (previous) return { ...previous, result: { ...previous.result, segments: previous.result.segments.slice(),
    events: previous.result.events.slice(), resets: previous.result.resets.slice() } };
  return { previous:null, model:null, tier:null, turnId:null, inherited:false,
    result: { id:null, forkedFrom:null, cwd:null, startedAt:null, model:null, segments:[], events:[], resets:[], invalidLines:0, counterResets:0, missingBaselines:0 } };
}

function consumeRecordLine(state, file, line) {
  const result = state.result;
  if (!line.trim()) return;
  let entry;
  try { entry = JSON.parse(line); } catch { result.invalidLines++; return; }
  const p = entry.payload;
  if (entry.type === "session_meta") {
    result.id = p?.id ?? result.id;
    result.cwd = p?.cwd ?? result.cwd;
    result.startedAt = p?.timestamp ?? entry.timestamp ?? result.startedAt;
    result.forkedFrom = p?.forked_from_id ?? p?.forked_from ?? null;
    // A subagent parent is not a fork: its first request is its own usage.
    state.inherited = !!result.forkedFrom;
  }
  if (entry.type === "turn_context") {
    state.model = p?.model ?? state.model;
    state.tier = p?.service_tier ?? p?.serviceTier ?? p?.collaboration_mode?.settings?.service_tier ?? null;
    state.turnId = p?.turn_id ?? p?.turnId ?? null;
    result.cwd = p?.cwd ?? result.cwd;
  }
  // Never inspect response_item/tool output as usage or quota evidence.
  if (entry.type !== "event_msg" || p?.type !== "token_count") return;
  const timestamp = entry.timestamp, ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return;
  const rawUsage = p.info?.total_token_usage ?? p.info?.totalTokenUsage;
  const usage = rawUsage ? normalizeTokenUsage(rawUsage) : null;
  const eventModel = p.model ?? state.model;
  const eventTier = p.service_tier ?? p.serviceTier ?? state.tier ?? "unknown";
  let delta = null, boundary = false;
  if (usage) {
    if (state.previous) {
      if (tokenUsageTotal(usage) < tokenUsageTotal(state.previous)) {
        // Rebase a reset; do not invent newly billed usage from a lower counter.
        result.counterResets++;
      } else delta = subtractTokenUsage(usage, state.previous);
    } else if (!state.inherited) { delta = usage; boundary = true; }
    else result.missingBaselines++;
    state.previous = usage;
  }
  const eventKey = crypto.createHash("sha256").update(JSON.stringify([timestamp, state.turnId, usage])).digest("hex");
  if (delta && tokenUsageTotal(delta) > 0) result.segments.push({ timestamp, ms, model:eventModel, cwd:result.cwd,
    serviceTier:eventTier, tokenUsage:delta, key:eventKey, first:boundary, startedAt:result.startedAt });
  const rates = bucketsFromRecord(p);
  for (const raw of rates) {
    const reset = normalizeResetCredits(raw.rateLimitResetCredits ?? raw.rate_limit_reset_credits, timestamp);
    if (reset) result.resets.push(reset);
  }
  const reset = normalizeResetCredits(p.rateLimitResetCredits ?? p.rate_limit_reset_credits, timestamp);
  if (reset) result.resets.push(reset);
  result.events.push({ timestamp, ms, model:eventModel, serviceTier:eventTier, tokenUsage:usage, delta,
    sessionId:result.id ?? file.path, key:eventKey, rates });
}

function recordValue(state, file) {
  return { ...state.result, model:state.model, id:state.result.id ?? file.path };
}

async function parseRecordFile(file) {
  const state = createRecordState();
  const source = fs.createReadStream(file.path);
  let input = source;
  if (file.path.endsWith(".gz")) input = source.pipe(zlib.createGunzip());
  if (file.path.endsWith(".zst")) {
    if (!zlib.createZstdDecompress) { source.destroy(); throw new Error("当前运行时不支持 Zstandard 日志"); }
    input = source.pipe(zlib.createZstdDecompress());
  }
  if(input!==source)source.on("error",(error)=>input.destroy(error));
  const lines = readline.createInterface({ input, crlfDelay:Infinity });
  try {
    for await (const line of lines) consumeRecordLine(state, file, line);
  } finally { lines.close(); input.destroy(); source.destroy(); }
  return recordValue(state, file);
}

async function fingerprintRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return { start, length, hash:crypto.createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex") };
}

async function readRecordUpdate(file, hit, onRead) {
  const handle = await fs.promises.open(file.path, "r");
  try {
    const stat = await handle.stat(), signature = `${stat.size}:${stat.mtimeMs}`;
    if (hit?.signature === signature && hit.stat.ino === stat.ino && hit.stat.birthtimeMs === stat.birthtimeMs) return hit;
    if (/\.(gz|zst)$/.test(file.path)) return { signature, stat, value:await parseRecordFile(file) };
    let append = !!hit?.state && stat.size > hit.stat.size && stat.ino === hit.stat.ino
      && stat.dev === hit.stat.dev && stat.birthtimeMs === hit.stat.birthtimeMs;
    if (append) {
      for (const old of hit.guards) {
        const current = await fingerprintRange(handle, old.start, old.length);
        if (current.hash !== old.hash) { append = false; break; }
      }
    }
    const state = createRecordState(append ? hit.state : null);
    let offset = append ? hit.offset : 0, parts = [], pendingBytes = 0;
    const start = offset;
    if (stat.size > start) {
      const stream = handle.createReadStream({ start, end:stat.size - 1, autoClose:false });
      for await (const chunk of stream) {
        let cursor = 0, newline;
        while ((newline = chunk.indexOf(10, cursor)) !== -1) {
          const part = chunk.subarray(cursor, newline);
          const line = parts.length ? Buffer.concat([...parts, part]) : part;
          consumeRecordLine(state, file, line.toString("utf8"));
          offset += pendingBytes + part.length + 1;
          parts = []; pendingBytes = 0; cursor = newline + 1;
        }
        if (cursor < chunk.length) { const part = chunk.subarray(cursor); parts.push(part); pendingBytes += part.length; }
      }
    }
    // Keep only complete lines in the checkpoint. A partial UTF-8/JSON tail is
    // re-read on append, so it cannot poison the next delta or be counted twice.
    let value = recordValue(state, file);
    if (pendingBytes) {
      const preview = createRecordState(state);
      consumeRecordLine(preview, file, Buffer.concat(parts).toString("utf8"));
      value = recordValue(preview, file);
    }
    const headLength = Math.min(stat.size, 4096), tailStart = Math.max(0, offset - 4096);
    const guards = [await fingerprintRange(handle, 0, headLength), await fingerprintRange(handle, tailStart, offset - tailStart)];
    onRead?.({ bytes:stat.size - start, incremental:append });
    return { signature, stat, state, offset, guards, value };
  } finally { await handle.close(); }
}

function createRecordCache({ onRead, maxEntries = 512 } = {}) {
  const cache = new Map(), pending = new Map();
  return async function read(file) {
    if (pending.has(file.path)) { await pending.get(file.path); return read(file); }
    const signature = `${file.size}:${file.mtimeMs}`;
    const hit = cache.get(file.path);
    if (hit?.signature === signature) return hit.value;
    const job = readRecordUpdate(file, hit, onRead).then((next) => {
      cache.delete(file.path); cache.set(file.path, next);
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return next.value;
    }).finally(() => { if (pending.get(file.path) === job) pending.delete(file.path); });
    pending.set(file.path, job);
    return job;
  };
}

function aggregateUsage(records, options = {}) {
  const since = options.since ? Date.parse(options.since) : null;
  const total = emptyTokenUsage(), seen = new Set(), sessions = new Map(), models = new Map(), days = new Map(), projects = new Map();
  const parents = new Map(records.map((r) => [r.id, typeof r.forkedFrom === "string" ? r.forkedFrom : null]));
  const origins = new Map();
  for (const r of records) {
    let id = r.id; const visited = new Set();
    while (parents.get(id) && !visited.has(id)) { visited.add(id); id = parents.get(id); }
    origins.set(r.id, id);
  }
  let duplicates = 0, boundaryIntervals = 0;
  const entries = records.flatMap((r) => r.segments.map((s) => ({r,s}))).sort((a,b) => a.s.ms-b.s.ms);
  for (const {r,s} of entries) {
    if (Number.isFinite(since) && s.ms < since) continue;
    if (Number.isFinite(since) && s.first && !(Date.parse(s.startedAt) >= since)) { boundaryIntervals++; continue; }
    const key = `${origins.get(r.id)}:${s.key}`;
    if (seen.has(key)) { duplicates++; continue; } seen.add(key);
    addTokenUsage(total, s.tokenUsage);
    const day = new Date(s.ms); const dayKey = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,"0")}-${String(day.getDate()).padStart(2,"0")}`;
    const cwd = Object.hasOwn(s, "cwd") ? s.cwd : r.cwd;
    for (const [map,key,extra] of [[models,s.model??"unknown",{model:s.model??"unknown"}], [days,dayKey,{day:dayKey}], [projects,cwd??"unknown",{project:cwd?path.basename(cwd):"未知项目",cwd}]]) {
      if (!map.has(key)) map.set(key,{...extra,tokenUsage:emptyTokenUsage(),ids:new Set()});
      const item=map.get(key); addTokenUsage(item.tokenUsage,s.tokenUsage); item.ids.add(r.id);
    }
    if (!sessions.has(r.id)) sessions.set(r.id,{id:r.id,cwd:r.cwd,title:options.indexMap?.get(r.id)?.thread_name??(r.cwd?path.basename(r.cwd):"会话"),tokenUsage:emptyTokenUsage()});
    const session=sessions.get(r.id); addTokenUsage(session.tokenUsage,s.tokenUsage);session.updatedAt=s.timestamp;session.model=s.model;
  }
  const values=(map)=>[...map.values()].map(({ids,...v})=>({...v,sessions:ids.size}));
  return { source:"local", checkedAt:new Date().toISOString(), since:options.since??null,
    tokenUsage:total, sessionsAnalyzed:sessions.size,
    models:values(models).sort((a,b)=>b.tokenUsage.totalTokens-a.tokenUsage.totalTokens),
    daily:values(days).sort((a,b)=>a.day.localeCompare(b.day)).slice(-7),
    projects:values(projects).sort((a,b)=>b.tokenUsage.totalTokens-a.tokenUsage.totalTokens).slice(0,10),
    recentSessions:[...sessions.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,12),
    coverage:{ duplicates, boundaryIntervals, invalidLines:records.reduce((n,r)=>n+r.invalidLines,0), counterResets:records.reduce((n,r)=>n+r.counterResets,0), missingBaselines:records.reduce((n,r)=>n+r.missingBaselines,0) },
  };
}

function quotaFromRecords(records, since) {
  const cutoff = Date.parse(since);
  // Account attribution must have a known switch/import boundary.
  if (!Number.isFinite(cutoff)) return null;
  const buckets=[];
  for (const r of records) for (const e of r.events) {
    if (e.ms < cutoff) continue;
    for (const raw of e.rates) buckets.push(normalizeBucket(raw,e.timestamp));
  }
  return combineBuckets(buckets);
}

module.exports = { numberOrNull, limitId, windowMinutes, windowFor, normalizeWindow, normalizeResetCredits, normalizeBucket, combineBuckets, bucketsFromRecord, parseRecordFile, createRecordCache, aggregateUsage, quotaFromRecords };
