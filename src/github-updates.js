const https = require("node:https");

const RELEASES_URL = "https://github.com/GboyCode/CodexAuth/releases";
const API_URL = "https://api.github.com/repos/GboyCode/CodexAuth/releases/latest";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function parseVersion(value) {
  const match = typeof value === "string" && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error("无法识别正式版本号。");
  return match.slice(1).map(BigInt);
}

function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function installerName(version, platform, arch) {
  if (platform === "win32" && arch === "x64") return `CodexAuthSwitch-Setup-${version}.exe`;
  if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return `CodexAuthSwitch-${version}-${arch}.dmg`;
  return null;
}

// Fixed public endpoint: no cookies, account identifiers, credentials or caller-supplied URLs.
function requestLatestRelease() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      error ? reject(error) : resolve(result);
    };
    const deadline = setTimeout(() => {
      req.destroy();
      finish(new Error("检查更新超时，请稍后重试。"));
    }, 15000);
    const req = https.get(API_URL, {
      headers: { "User-Agent": "CodexAuth-Switch", Accept: "application/vnd.github+json" },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const message = [403, 429].includes(res.statusCode)
          ? "GitHub 暂时限制了请求，请稍后重试。"
          : res.statusCode === 404 ? "GitHub 暂无可用的正式发布版本。"
            : `GitHub 更新检查失败（HTTP ${res.statusCode}）。`;
        finish(new Error(message));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish(new Error("GitHub 更新响应过大，请稍后重试。"));
          res.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new Error("GitHub 返回了无效的更新信息。")); }
      });
      res.on("error", () => finish(new Error("读取 GitHub 更新信息失败，请稍后重试。")));
    });
    req.on("error", () => finish(new Error("无法连接 GitHub，请检查网络后重试。")));
  });
}

function selectRelease(release, currentVersion, platform, arch) {
  if (!release || release.draft !== false || release.prerelease !== false) throw new Error("GitHub 返回的不是正式发布版本。");
  parseVersion(release.tag_name);
  const latestVersion = release.tag_name.replace(/^v/, "");
  const comparison = compareVersions(latestVersion, currentVersion);
  const releaseUrl = `${RELEASES_URL}/tag/${release.tag_name}`;
  const expectedName = installerName(latestVersion, platform, arch);
  const expectedUrl = expectedName ? `${RELEASES_URL}/download/${release.tag_name}/${expectedName}` : null;
  // Match exact repository, tag and filename; never open an arbitrary URL from the response.
  const asset = Array.isArray(release.assets) && release.assets.find((item) =>
    item.name === expectedName && item.browser_download_url === expectedUrl &&
    item.state === "uploaded" && Number.isSafeInteger(item.size) && item.size > 0);
  return {
    currentVersion, latestVersion, comparison, releaseUrl,
    installer: asset ? { name: expectedName, url: expectedUrl, size: asset.size } : null,
  };
}

function createUpdateChecker({ currentVersion, platform = process.platform, arch = process.arch,
  request = requestLatestRelease, now = Date.now }) {
  let cached = null, checkedAt = 0, pending = null;
  return {
    check() {
      if (cached && now() - checkedAt < 60000) return Promise.resolve(cached);
      if (pending) return pending;
      pending = Promise.resolve().then(request).then((release) => {
        const result = selectRelease(release, currentVersion, platform, arch);
        checkedAt = now();
        cached = { ...result, checkedAt };
        return cached;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { createUpdateChecker, compareVersions, installerName, selectRelease, requestLatestRelease };
