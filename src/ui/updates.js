(() => {
  const button = document.querySelector("#checkUpdatesBtn");
  if (!button) return;
  const label = document.querySelector("#appVersion");
  const status = document.querySelector("#updateStatus");
  const api = window.codexAuth;
  api.getVersion().then((version) => {
    label.textContent = `v${version}`;
    button.title = `当前版本 v${version}，点击从 GitHub 检查更新`;
    button.setAttribute("aria-label", button.title);
  }).catch(() => { label.textContent = "版本未知"; });
  button.addEventListener("click", async () => {
    button.disabled = true;
    const original = label.textContent;
    label.textContent = "检查中…";
    if (status) status.textContent = "正在连接 GitHub…";
    try {
      const result = await api.checkForUpdates();
      if (status) status.textContent = result.busy ? "另一个窗口正在检查更新" : result.ok ? `已检查 · GitHub v${result.latestVersion}` : "检查失败，可点击重试";
    } catch {
      button.title = "检查失败，请点击重试";
      if (status) status.textContent = "检查失败，可点击重试";
    } finally {
      label.textContent = original;
      button.disabled = false;
    }
  });
})();
