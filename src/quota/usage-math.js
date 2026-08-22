const {
  cloneTokenUsage,
  subtractTokenUsage,
  tokenUsageTotal,
} = require("./token-math");

function scopedTokenDelta(currentUsage, previousUsage, options = {}) {
  const sinceMs = Number(options.sinceMs);
  const eventMs = Number(options.eventMs);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(eventMs) || eventMs < sinceMs) return null;

  let delta = null;
  if (previousUsage) {
    delta = subtractTokenUsage(currentUsage, previousUsage);
  } else {
    const sessionStartedMs = Number(options.sessionStartedMs);
    if (Number.isFinite(sessionStartedMs) && sessionStartedMs >= sinceMs) {
      delta = cloneTokenUsage(currentUsage);
    }
  }

  return delta && tokenUsageTotal(delta) > 0 ? delta : null;
}

module.exports = {
  scopedTokenDelta,
};
