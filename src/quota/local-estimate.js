const { tokenUsageTotal, subtractTokenUsage, median } = require("./token-math");
const { limitId, windowFor, normalizeWindow, numberOrNull } = require("./local-records");

const ALGORITHM = 4;
function contextKey(id, model, tier, kind) { return JSON.stringify([id,model??"unknown",tier??"unknown",kind]); }
function sameWindow(a,b) { return a?.resetsAt === b?.resetsAt && a?.windowMinutes === b?.windowMinutes; }

// Learn percentages per raw input+output token from this account's local events.
// No API price table, invented model multiplier, or cross-plan fallback.
function estimateLocalQuota(quota, records, {since, calibration} = {}) {
  if (!quota) return quota;
  const cutoff=Date.parse(since);
  const groups = Object.create(null);
  if (calibration?.algorithm === ALGORITHM) {
    for (const [key,samples] of Object.entries(calibration.groups??{})) {
      if (Array.isArray(samples)) groups[key]=samples.filter((s)=>Number.isFinite(s.coefficient)&&s.coefficient>0&&s.ms>Date.now()-7*86400000).slice(-30);
    }
  }
  const changes=new Map(), seen=new Set(), deltas=[];
  for (const record of records) {
    const trackers=new Map();
    for (const event of record.events) {
      if (!Number.isFinite(cutoff) || event.ms < cutoff || !event.tokenUsage) continue;
      const ids=new Set(event.rates.map(limitId));
      if (!seen.has(event.key) && event.delta) { deltas.push({...event,ids}); seen.add(event.key); }
      for (const raw of event.rates) for (const kind of ["session","weekly"]) {
        const w=normalizeWindow(windowFor(raw,kind),event.timestamp);
        if (w?.usedPercent === null || !w) continue;
        const id=limitId(raw), key=contextKey(id,event.model,event.serviceTier,kind);
        const prev=trackers.get(`${id}:${kind}`);
        const point={...event,window:w,context:key};
        if (!prev || !sameWindow(prev.window,w) || prev.context!==key || tokenUsageTotal(event.tokenUsage)<tokenUsageTotal(prev.tokenUsage)) {
          trackers.set(`${id}:${kind}`,point);
        } else if (prev.window.usedPercent !== w.usedPercent) {
          const units=tokenUsageTotal(subtractTokenUsage(event.tokenUsage,prev.tokenUsage));
          const percent=w.usedPercent-prev.window.usedPercent;
          if (units>=1000 && percent>0 && percent<=40 && event.model && event.serviceTier!=="unknown") {
            const samples=groups[key]??=[];
            const sampleKey=`${prev.key}:${event.key}`;
            if (!samples.some((s)=>s.key===sampleKey)) samples.push({key:sampleKey,ms:event.ms,coefficient:percent/units});
            groups[key]=samples.slice(-30);
          }
          trackers.set(`${id}:${kind}`,point);
        }
        const globalKey=`${id}:${kind}`;
        const anchor=trackers.get(globalKey);
        const latest=changes.get(globalKey);
        // Retain the last value-change boundary, including same-value polls.
        if (!latest || anchor.ms>latest.ms) changes.set(globalKey,anchor);
      }
    }
  }
  const apply=(bucket)=>{
    const next={...bucket}; let available=false; const reasons=new Set();
    for (const kind of ["session","weekly"]) {
      const base=bucket[kind], anchor=changes.get(`${bucket.limitId}:${kind}`);
      if (!base || base.usedPercent===null || !anchor || !sameWindow(base,anchor.window) || base.usedPercent!==anchor.window.usedPercent || base.resetsAt*1000<=Date.now()) continue;
      let deltaPercent=0,sampleCount=Infinity,units=0,unsupported=false;
      const after=deltas.filter((e)=>e.ms>anchor.ms && e.ids.has(bucket.limitId));
      for (const event of after) {
        const key=contextKey(bucket.limitId,event.model,event.serviceTier,kind);
        const samples=groups[key]??[];
        if (samples.length<3) { unsupported=true; reasons.add("当前模型/速度档缺少本账号的本地校准样本"); continue; }
        const n=tokenUsageTotal(event.delta);deltaPercent+=median(samples.map((s)=>s.coefficient))*n;units+=n;sampleCount=Math.min(sampleCount,samples.length);
      }
      if (!unsupported && deltaPercent>=0.25 && base.usedPercent<100) {
        const used=Math.min(100,base.usedPercent+deltaPercent);
        next[kind]={...base,estimatedUsedPercent:Math.ceil(used),estimatedRemainingPercent:Math.floor(100-used),estimatedDeltaPercent:Math.round((used-base.usedPercent)*10)/10,estimatedWeightedTokens:units,estimateSamples:sampleCount};available=true;
      }
    }
    next.estimate={source:"local-estimate",algorithm:ALGORITHM,available,confidence:"calibrated",reason:available?null:[...reasons][0]??"等待快照后的可校准 Token 增量"};
    return next;
  };
  // Old/invalid calibration cannot carry estimates onto a new model or bucket.
  const {additional,...main}=quota;
  return {...apply(main),additional:(additional??[]).map(apply),calibration:{algorithm:ALGORITHM,groups}};
}
module.exports={ ALGORITHM, contextKey, estimateLocalQuota };
