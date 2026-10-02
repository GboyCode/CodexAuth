# CodexAuth 展示网站

网站源码在 `site/`，构建后是无需后端、CDN 脚本或前端框架的静态 HTML / CSS / JavaScript。正式域名为 **https://codexauth.toagi.cc**。演示账号均为虚构的 `example.com` 地址，不读取桌面登录数据。下载入口链接到 GitHub 最新 Release，不把本地软件版本误标为线上最新版本。

## 本地调试

在仓库根目录运行：

```powershell
npm ci --prefix site
npm run site:dev
```

打开 `http://127.0.0.1:4173`，或直接访问 `/zh/`、`/en/`。修改模板、文案、样式后自动重新生成页面，刷新浏览器即可；修改构建脚本需重启服务。服务只监听本机，只提供 `site/dist/` 下的公共文件，禁用浏览器缓存，并返回禁止收录的响应头。若端口被占用，可在 PowerShell 中先设置 `$env:SITE_PORT = '4174'`，再运行同一命令。

样式继承桌面面板的石墨灰配色。`site/assets/theme.css` 是 `src/ui/theme.css` 的发布副本；图标也来自桌面应用。桌面主题变更时按需同步这份副本。

## Cloudflare Pages

Cloudflare 的 `MrgCloud` 账户下，**Pages** 项目 `codexauth` 已关联 GitHub 仓库 `GboyCode/CodexAuth`。项目默认地址为 `https://codexauth-1wh.pages.dev`，自定义域名为 `codexauth.toagi.cc`。网站只发布 `site/dist` 中的静态文件，不发布桌面程序或整个仓库。

更新网站时，修改 `site/` 中的文件，提交并推送到 `main`。Cloudflare 会自动拉取该提交、安装网站依赖、验证并构建，成功后更新正式域名。构建失败时保留上一次成功部署。无需本地常驻服务或手动上传发布包。

### Git 自动发布与检查

发布由 Cloudflare Pages 原生 Git 集成负责，GitHub Actions 的 `.github/workflows/website.yml` 只做网站检查。生产构建自身也会运行相同验证，通过后才发布，因此不依赖两个平台任务的完成顺序。无需设置 `CLOUDFLARE_API_TOKEN` 仓库 Secret。

- `main` 分支推送修改了 `site/` 时自动更新正式站点，域名和 DNS 保持不变。
- Pull Request 运行网站检查；Cloudflare 分支预览部署关闭。
- GitHub Actions → Website checks → Run workflow 只重新运行检查。需要重新发布相同提交时，在 Pages 的部署详情中重试该部署。
- 网站的文字、布局和交互来自 `site/`；桌面程序代码或 README 的修改不会自动变成网站文案。下载按钮始终指向 GitHub 最新 Release。
- Cloudflare 项目的 Git 来源为 `GboyCode/CodexAuth`，生产分支为 `main`；在部署详情中可核对提交 ID。

2026-10-02 已通过 Cloudflare MCP 的 `POST /accounts/{account_id}/pages/projects/{project_name}/source` 接口为原有直接上传项目连接 Git 来源，未新建项目或迁移域名。部分入门文档仍描述不能从直接上传转换；这里以本项目实际 API 状态为准。

### 构建参数

当前 Pages 构建设置如下。参考 [Cloudflare 静态 HTML 指南](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)：

| 设置 | 值 |
| --- | --- |
| 生产分支 | `main`（与 `site.config.json` 保持一致） |
| 框架预设 | None |
| 根目录 | `site` |
| 构建命令 | `npm run validate && npm run build` |
| 构建输出目录 | `dist` |
| Node.js | `NODE_VERSION=24` |

Pages 在 `site` 内安装独立依赖（只有构建时使用的 HTML 解析器），不需要安装 Electron，不需要 Pages Functions 或 Worker。构建监视路径为 `site/*`。

已通过 Pages「自定义域」绑定 `codexauth.toagi.cc`，Cloudflare 自动创建 `codexauth` → `codexauth-1wh.pages.dev` 的 CNAME；控制台显示「活动 / SSL 已启用」。迁移域名时仍应通过 Pages 绑定，不要仅手动添加 CNAME。`site/site.config.json` 管理正式 HTTPS 域名和生产分支；也可用构建环境变量 `SITE_URL` 覆盖域名。不要把预览域名填入该值。

构建器为虚构的演示邮箱添加 Cloudflare 的 `email_off` 注释，防止邮箱混淆功能改写演示内容或注入解码脚本；域名的全局邮箱保护设置保持不变。

构建产物包含静态响应头 `_headers`、语言路径重定向 `_redirects` 和 `404.html`。Cloudflare 非生产分支预览会自动生成 `noindex, nofollow` 和禁止抓取的 `robots.txt`；主分支产物允许收录。生产分支更名时同时更新配置，否则会被当作预览站。原始源码不属于发布产物。

## 语言与 SEO

- `/` 是 `x-default` 入口：优先采用手动选择的本地偏好，其次按浏览器设备语言列表选择中文或英文，均不匹配时用英文。保留 URL 查询参数和锚点。禁用 JavaScript 时仍有两个语言入口。
- `/zh/` 和 `/en/` 有各自完整的静态正文，不依赖 JavaScript 翻译。直接访问这些网址始终尊重网址语言；导航栏可手动切换并记忆偏好。
- 不依赖 IP 地理位置或第三方定位接口，避免代理网络出口误判用户语言。设备语言比网络地区更符合用户偏好。
- 每种语言有独立标题、描述、HTML `lang`、自指 canonical，以及互相关联的 `hreflang` 和 `x-default`。`sitemap.xml` 与 `robots.txt` 使用正式域名。
- 分享信息包含 Open Graph、Twitter Card 和真实应用图标。JSON-LD 描述网站、页面、软件与页面中的 FAQ；不虚构评分、评论、下载量或最新版本。结构化数据不保证搜索结果出现富媒体样式。
- 使用系统字体、同源资源和原生模块，无外部字体、追踪脚本或运行时翻译请求。内容语义、键盘操作、减少动效偏好和移动端布局均纳入检查。

这个方案遵循 Google 的[多语言页面关联说明](https://developers.google.com/search/docs/specialty/international/localized-versions)和[语言入口页建议](https://developers.google.com/search/blog/2014/05/creating-right-homepage-for-your)。静态站不需要服务器端地区判断。

本地生产构建和针对性检查：

```powershell
npm run site:build
npm run site:validate
```

验证覆盖输出 HTML、中英文静态内容、唯一 H1、canonical、hreflang、结构化数据与 CSP、内部链接与资源、站点地图、预览禁止收录，以及语言选择优先级。开发服务和生产构建共用 `site/dist`；发布前运行生产构建，直接上传时也只上传 `dist`。

正式域名的 HTTPS、中英文页面、资源一致性、可抓取响应、站点地图、404 和语言路径重定向已在线验证。后续可在 Google Search Console 验证域名并提交 `https://codexauth.toagi.cc/sitemap.xml`，以及在 Bing Webmaster Tools 提交站点。检查 Pages 默认域名是否被索引，按 Cloudflare 的[生产 pages.dev 重定向指引](https://developers.cloudflare.com/pages/how-to/redirect-to-custom-domain/)将生产别名归一到正式域名。搜索收录和排名取决于上线后的抓取与内容表现。

## 验证要点

- 首屏用两行主标题突出额度用尽后自动换号、继续原任务；副文案保留 Windows 可选开启的适用范围。
- 主面板和桌面浮窗默认并排，窄屏上下排列；任一端切换账号同步双额度和账号列表，全部为示例数据。
- 浮窗保留真实界面的双额度、重置信息、快速切换和快捷操作布局。透明度可调整；重登和重启仅显示演示说明。
- 账号/用量页签支持方向键、Home / End；浮窗获得焦点时可按 Escape 收起，设置菜单和手机导航也支持 Escape。
- 邮箱隐藏、中英文切换、系统选择、FAQ 与 GitHub 下载链接可操作。
- 检查桌面与手机宽度、键盘焦点、减少动态效果偏好、控制台和资源错误。
- 背景采用淡点阵与鼠标跟随柔光。跟随只在精细指针设备启用，支持减少动态效果偏好；离开页面后停止，背景不截获点击。
- 页面内容不依赖 JavaScript 才能展示；交互预览依赖 JavaScript。

已创建 Pages 项目并发布，正式域名与 HTTPS 已生效。搜索引擎站长平台尚未提交。
