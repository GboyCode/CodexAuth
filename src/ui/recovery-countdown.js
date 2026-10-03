const t = (...args) => window.CodexI18n.t(...args);
const api = window.codexAuth;
const seconds = document.querySelector("#seconds");
const card = document.querySelector("main");
const cancel = document.querySelector("#cancelBtn");
const title = document.querySelector("#title");
let lastState = null;
function render(state) {
  if (!state) return;
  lastState = state;
  seconds.textContent = state.seconds;
  title.textContent = state.usesReset ? t("将使用 1 张重置卡") : t("自动切换账号");
  card.title = t("切换到 {0}，重启 Codex 并继续 {1} 个任务", state.targetLabel, state.taskCount);
}
async function cancelOnce() {
  if (cancel.disabled) return;
  cancel.disabled = true;
  try { await api.cancelRecoveryCountdown(); }
  catch { cancel.disabled = false; cancel.textContent = t("重试取消"); }
}
cancel.addEventListener("click", cancelOnce);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") cancelOnce(); });
api.onRecoveryCountdown(render);
api.getState().then((snapshot) => {
  window.CodexI18n.setLanguage(snapshot?.settings?.language);
  render(lastState);
}).catch(() => {});
api.onStateChanged(() => api.getState().then((snapshot) => {
  window.CodexI18n.setLanguage(snapshot?.settings?.language);
  render(lastState);
}).catch(() => {}));
api.readyRecoveryCountdown().then(render).catch(cancelOnce);
