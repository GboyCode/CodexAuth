const api = window.codexAuth;
const seconds = document.querySelector("#seconds");
const target = document.querySelector("#targetAccount");
const summary = document.querySelector("#taskSummary");
const cancel = document.querySelector("#cancelBtn");
function render(state) {
  if (!state) return;
  seconds.textContent = state.seconds;
  target.textContent = state.targetLabel;
  target.title = state.targetLabel;
  summary.textContent = `将重启 Codex，并向 ${state.taskCount} 个中断任务发送继续指令。`;
}
async function cancelOnce() {
  cancel.disabled = true;
  try { await api.cancelRecoveryCountdown(); }
  catch { cancel.disabled = false; cancel.textContent = "取消未成功，请重试"; }
}
cancel.addEventListener("click", cancelOnce);
document.querySelector("#closeBtn").addEventListener("click", cancelOnce);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") cancelOnce(); });
api.onRecoveryCountdown(render);
api.readyRecoveryCountdown().then(render).catch(cancelOnce);
