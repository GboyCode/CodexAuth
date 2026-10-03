(() => {
  const t = (...args) => window.CodexI18n.t(...args);
  const buttons = [...document.querySelectorAll("#checkUpdatesBtn, [data-check-updates]")];
  if (!buttons.length) return;
  const labels = [...document.querySelectorAll("#appVersion, [data-app-version]")];
  const status = document.querySelector("#updateStatus");
  const api = window.codexAuth;
  let checking = false;
  let version = null;
  let statusMessage = [];
  function render() {
    labels.forEach((label) => { label.textContent = version ? `v${version}` : t("版本未知"); });
    buttons.forEach((button) => {
      button.title = version ? t("当前版本 v{0}，点击从 GitHub 检查更新", version) : t("检查更新");
      button.setAttribute("aria-label", button.title);
    });
    if (status) status.textContent = statusMessage.length ? t(...statusMessage) : "";
  }
  function setStatus(...message) { statusMessage = message; render(); }
  document.addEventListener("languagechange", render);
  api.getVersion().then((value) => { version = value; render(); }).catch(render);
  async function check() {
    if (checking) return;
    checking = true;
    buttons.forEach((button) => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
    setStatus("正在连接 GitHub…");
    try {
      const result = await api.checkForUpdates();
      setStatus(...(result.busy ? ["另一个窗口正在检查更新"] : !result.ok ? ["检查失败，可点击重试"]
        : result.comparison > 0 ? ["发现新版本 v{0}", result.latestVersion]
          : result.comparison === 0 ? ["当前已是最新正式版"]
            : result.comparison < 0 ? ["本机版本较新 · GitHub v{0}", result.latestVersion] : ["已检查 · GitHub v{0}", result.latestVersion]));
    } catch {
      setStatus("检查失败，可点击重试");
    } finally {
      checking = false;
      buttons.forEach((button) => { button.disabled = false; button.removeAttribute("aria-busy"); });
    }
  }
  buttons.forEach((button) => button.addEventListener("click", check));
  document.querySelectorAll("[data-app-link]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      try { await api.openAppLink(link.dataset.appLink); }
      catch { setStatus("无法打开浏览器，请稍后重试"); }
    });
  });
})();
