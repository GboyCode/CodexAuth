(() => {
  const surfaces = ".topbar, .status-panel:first-child, .primary-btn, .account-action.primary, .page-tab, .scope-tab, .quick-actions .primary-action, .account-row button.primary, .head-actions button, .cancel";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)");
  let current = null;
  let pending = null;
  let frame = null;

  function clear() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    pending = null;
    current?.style.setProperty("--glass-active", "0");
    current = null;
  }

  function paint() {
    frame = null;
    const point = pending;
    pending = null;
    if (!point || reduced.matches || document.hidden || !point.target.isConnected || point.target.matches(":disabled")) return clear();
    if (current !== point.target) {
      current?.style.setProperty("--glass-active", "0");
      current = point.target;
      current.classList.add("glass-tracked");
    }
    const bounds = current.getBoundingClientRect();
    current.style.setProperty("--glass-x", `${Math.round(point.x - bounds.left)}px`);
    current.style.setProperty("--glass-y", `${Math.round(point.y - bounds.top)}px`);
    current.style.setProperty("--glass-active", "1");
  }

  document.addEventListener("pointermove", event => {
    if (reduced.matches || document.hidden || event.buttons || !["mouse", "pen"].includes(event.pointerType)) return clear();
    const target = event.target.closest?.(surfaces);
    if (!target || target.matches(":disabled")) return clear();
    pending = { target, x: event.clientX, y: event.clientY };
    if (frame === null) frame = window.requestAnimationFrame(paint);
  }, { passive: true });
  document.addEventListener("pointerleave", clear);
  document.addEventListener("pointerdown", clear, { passive: true });
  document.addEventListener("scroll", clear, { passive: true, capture: true });
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("blur", clear);
  window.addEventListener("pagehide", clear);
  reduced.addEventListener("change", clear);
})();
