(() => {
  const api = window.codexAuth;
  const control = document.querySelector("#loginItemControl");
  const toggle = document.querySelector("#launchAtLogin");
  const status = document.querySelector("#loginItemStatus");
  const t = (...args) => window.CodexI18n.t(...args);
  let checked = false;
  function render(snapshot) {
    if (api.platform !== "darwin") return;
    control.hidden = false;
    checked = snapshot.settings?.launchAtLogin === true;
    toggle.checked = checked;
    status.textContent = snapshot.settings?.launchAtLoginStatus === "requires-approval"
      ? t("请在系统设置 → 通用 → 登录项中允许启动。") : "";
    status.hidden = !status.textContent;
  }
  if (api.platform === "darwin") toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try { render(await api.updateSettings({ launchAtLogin: toggle.checked })); }
    catch (error) { toggle.checked = checked; status.textContent = t(error.message); status.hidden = false; }
    finally { toggle.disabled = false; }
  });
  window.CodexLoginItemUI = { render };
})();
