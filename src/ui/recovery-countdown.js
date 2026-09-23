const api = window.codexAuth;
const seconds = document.querySelector("#seconds");
const card = document.querySelector("main");
const cancel = document.querySelector("#cancelBtn");
function render(state) {
  if (!state) return;
  seconds.textContent = state.seconds;
  card.title = `切换到 ${state.targetLabel}，重启 Codex 并继续 ${state.taskCount} 个任务`;
}
async function cancelOnce() {
  if (cancel.disabled) return;
  cancel.disabled = true;
  try { await api.cancelRecoveryCountdown(); }
  catch { cancel.disabled = false; cancel.textContent = "重试取消"; }
}
cancel.addEventListener("click", cancelOnce);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") cancelOnce(); });
api.onRecoveryCountdown(render);
api.readyRecoveryCountdown().then(render).catch(cancelOnce);
