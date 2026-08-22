const assert = require("node:assert/strict");
const { scopedTokenDelta } = require("../src/quota/usage-math");

function usage(totalTokens, inputTokens = totalTokens, outputTokens = 0) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens,
  };
}

assert.equal(
  scopedTokenDelta(usage(120), null, {
    sinceMs: 100,
    eventMs: 120,
    sessionStartedMs: 80,
  }),
  null
);

assert.deepEqual(
  scopedTokenDelta(usage(170, 130, 40), usage(120, 100, 20), {
    sinceMs: 100,
    eventMs: 140,
    sessionStartedMs: 80,
  }),
  usage(50, 30, 20)
);

assert.deepEqual(
  scopedTokenDelta(usage(90, 70, 20), null, {
    sinceMs: 100,
    eventMs: 140,
    sessionStartedMs: 110,
  }),
  usage(90, 70, 20)
);

assert.equal(
  scopedTokenDelta(usage(80), usage(100), {
    sinceMs: 100,
    eventMs: 140,
    sessionStartedMs: 80,
  }),
  null
);

assert.equal(
  scopedTokenDelta(usage(170), usage(120), {
    sinceMs: 150,
    eventMs: 140,
    sessionStartedMs: 80,
  }),
  null
);

console.log("Account-switch token scope validation passed.");
