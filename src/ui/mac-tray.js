const api = window.codexAuth;
const t = (...args) => window.CodexI18n.t(...args);
const q = window.CodexQuotaUI;
const accounts = document.querySelector("#accounts");
const notice = document.querySelector("#notice");
let snapshot;
let busy = false;
let request = 0;

function render() {
  window.CodexI18n.setLanguage(snapshot.settings?.language);
  const current = snapshot.current;
  document.querySelector("#current").textContent = current?.exists && !current.error
    ? current.email || current.userId || t("未知账号") : t("未检测到登录");
  document.querySelector("#switchHint").textContent = snapshot.settings?.restartAfterSwitch !== false
    ? t("切换账号将重启 Codex") : t("切换后需手动重启 Codex 才能生效");
  accounts.replaceChildren();
  if (!snapshot.accounts.length) accounts.textContent = t("还没有保存的账号");
  for (const account of snapshot.accounts) {
    const row = document.createElement("div");
    row.className = "account";
    row.dataset.accountId = account.id;
    const info = document.createElement("div");
    info.className = "account-info";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = account.displayName;
    name.title = account.displayName;
    const identity = document.createElement("span");
    identity.className = "identity";
    identity.textContent = account.email || account.userId || "";
    identity.title = identity.textContent;
    info.append(name, identity);
    const quota = document.createElement("span");
    quota.className = "quota";
    quota.textContent = ["session", "weekly"].map(kind =>
      `${q.windowTitle(kind, account.quotaSnapshot?.[kind])} ${q.formatRemainingText(account.quotaSnapshot?.[kind])}`
    ).join(" · ");
    quota.title = q.quotaFreshnessLabel(account.quotaSnapshot);
    info.append(quota);
    row.append(info);
    if (account.isActive && !account.needsReauth) {
      const active = document.createElement("span");
      active.className = "active";
      active.textContent = t("当前");
      row.append(active);
    } else {
      const button = document.createElement("button");
      button.textContent = account.needsReauth ? t("重新登录") : t("切换");
      button.disabled = busy;
      button.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        notice.textContent = "";
        render();
        try {
          if (account.needsReauth) {
            await api.showMainWindow();
            await api.reauthAccount(account.id);
          } else {
            const result = await api.switchAccount(account.id, { restartCodex: snapshot.settings?.restartAfterSwitch !== false });
            if (!result?.canceled) await refresh();
          }
        } catch (error) {
          notice.textContent = t(error.message);
        } finally {
          busy = false;
          render();
        }
      });
      row.append(button);
    }
    accounts.append(row);
  }
}

async function refresh() {
  const id = ++request;
  const result = await api.getState();
  if (id !== request) return;
  snapshot = result;
  render();
  await api.getQuota();
  const updated = await api.getState();
  if (id !== request) return;
  snapshot = updated;
  render();
}
const report = error => { notice.textContent = t(error.message); };
document.querySelector("#manage").addEventListener("click", () => api.showMainWindow().catch(report));
document.addEventListener("keydown", event => { if (event.key === "Escape") api.hideWidget().catch(report); });
api.onStateChanged(() => refresh().catch(report));
setInterval(() => { if (!document.hidden && !busy) refresh().catch(report); }, 60000);
refresh().catch(report);
