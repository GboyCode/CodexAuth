(async () => {
  const api = window.codexMessage;
  const data = await api.ready();
  if (!data) return;
  document.body.classList.toggle("compact", data.compact);
  document.title = data.title;
  document.querySelector("#title").textContent = data.title;
  document.querySelector("#message").textContent = data.message;
  document.querySelector("#detail").textContent = data.detail;
  const actions = document.querySelector("#actions");
  const surface = document.querySelector("main");
  let dragPointer = null;
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button, #detail") || event.target.classList.contains("message-copy")) return;
    event.preventDefault();
    dragPointer = event.pointerId;
    surface.setPointerCapture(dragPointer);
    api.drag("start", { x: event.screenX, y: event.screenY });
  });
  surface.addEventListener("pointermove", (event) => {
    if (event.pointerId === dragPointer) api.drag("move", { x: event.screenX, y: event.screenY });
  });
  const endDrag = (event) => {
    if (event.pointerId !== dragPointer) return;
    api.drag("end");
    dragPointer = null;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  };
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => surface.addEventListener(type, endDrag));
  surface.addEventListener("dragstart", (event) => event.preventDefault());
  let chosen = false;
  const choose = (id) => {
    if (chosen) return;
    chosen = true;
    document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    api.choose(id);
  };
  const buttons = data.buttons.map((label, id) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = id === data.primaryId ? "primary-btn" : "ghost-btn";
    button.addEventListener("click", () => choose(id));
    return button;
  });
  // Keep response ids stable while putting the main action at the right edge.
  buttons.forEach((button, id) => { if (id !== data.primaryId) actions.append(button); });
  actions.append(buttons[data.primaryId]);
  document.querySelector("#closeBtn").addEventListener("click", () => choose(data.cancelId));
  document.addEventListener("pointerdown", () => document.body.classList.remove("keyboard-navigation"), true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); choose(data.cancelId); }
    if (event.key !== "Tab") return;
    document.body.classList.add("keyboard-navigation");
    const focusable = [...document.querySelectorAll("button:not(:disabled)")];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  await document.fonts.ready;
  api.present(Math.ceil(document.querySelector("main").getBoundingClientRect().height));
  buttons[data.defaultId].focus();
})();
