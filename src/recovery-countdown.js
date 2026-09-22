const COUNTDOWN_MS = 15000;

// The main process owns the deadline. A missing, closed, or crashed reminder
// never permits an account switch. Renderer readiness starts the full 15 seconds.
function createRecoveryCountdown({ createWindow, now = Date.now, schedule = setInterval, unschedule = clearInterval }) {
  let active = null;
  const snapshot = (entry) => ({ ...entry.details, seconds: entry.deadline === null ? 15
    : Math.max(0, Math.ceil((entry.deadline - now()) / 1000)) });
  function finish(result) {
    if (!active) return false;
    const entry = active;
    active = null;
    unschedule(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
    entry.resolve(result);
    return true;
  }
  function request(details, signal) {
    finish("cancelled");
    if (signal?.aborted) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      const entry = { details, signal, resolve, deadline: null, lastTick: now(), openedAt: now(), lastSeconds: null };
      active = entry;
      entry.abort = () => finish("cancelled");
      signal?.addEventListener("abort", entry.abort, { once: true });
      try {
        entry.win = createWindow();
        entry.win.once("closed", () => { if (active === entry) finish("cancelled"); });
        entry.win.on("hide", () => { if (active === entry) finish("cancelled"); });
        entry.win.once("unresponsive", () => { if (active === entry) finish("unavailable"); });
        for (const event of ["render-process-gone", "did-fail-load", "unresponsive"]) {
          entry.win.webContents.once(event, () => { if (active === entry) finish("unavailable"); });
        }
        entry.timer = schedule(() => {
          if (active !== entry) return;
          const time = now();
          // After sleep or a stalled event loop, cancel instead of skipping the warning.
          if (time - entry.lastTick > 3000 || time < entry.lastTick) { finish("unavailable"); return; }
          entry.lastTick = time;
          if (entry.deadline === null) {
            if (time - entry.openedAt >= 10000) finish("unavailable");
            return;
          }
          if (time >= entry.deadline) { finish("elapsed"); return; }
          try { publish(entry); } catch { finish("unavailable"); }
        }, 250);
      } catch { finish("unavailable"); }
    });
  }
  function publish(entry) {
    const state = snapshot(entry);
    if (state.seconds !== entry.lastSeconds) {
      entry.lastSeconds = state.seconds;
      entry.win.webContents.send("recovery-countdown:changed", state);
    }
    return state;
  }
  function ready(sender) {
    if (!active || active.win?.webContents !== sender) return null;
    const entry = active;
    try {
      if (entry.deadline === null) {
        entry.deadline = now() + COUNTDOWN_MS;
        entry.lastTick = now();
        entry.win.show();
        entry.win.focus();
      }
      return publish(entry);
    } catch { finish("unavailable"); return null; }
  }
  function cancel(sender) {
    if (!active || active.win?.webContents !== sender) return false;
    return finish("cancelled");
  }
  return { request, ready, cancel };
}

module.exports = { createRecoveryCountdown, COUNTDOWN_MS };
