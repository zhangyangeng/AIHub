# Aihub

[![CI](https://github.com/zhangyangeng/AIHub/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangyangeng/AIHub/actions/workflows/ci.yml)
[![Build](https://github.com/zhangyangeng/AIHub/actions/workflows/build-tauri.yml/badge.svg)](https://github.com/zhangyangeng/AIHub/actions/workflows/build-tauri.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20·%20macOS%20(Apple%20Silicon)-0078d4.svg)](#安装)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db.svg)](https://tauri.app/)

<img src="assets/brand/logo.png" alt="Aihub" width="420" />

把 DeepSeek、ChatGPT、Claude、豆包、Kimi、智谱 GLM、Gemini 等网页版 AI 应用聚合到一个窗口里，
用顶部标签切换，**每个服务的登录态各自独立保存、下次启动保持登录**。

内置站点：**DeepSeek / ChatGPT / Claude / 豆包 / Kimi / 智谱 GLM / Gemini**，
每个都自带一份本地 logo（不依赖网站 favicon，也不用点开才显示），
想加别家（通义、元宝、文心、Grok、Mistral……）在设置里「填名字 + 网址」就行。

技术路线是「网页套壳」：不使用官方 API，直接嵌入各家网页，所以功能、界面永远和官网一致，
也不需要自己维护模型适配。

<img width="2237" height="1550" alt="image" src="https://github.com/user-attachments/assets/d41b897d-a8af-4bc9-9881-bea3b2b0b1b5" />

> 每个站点都是独立加载的原生视图（不是把网页塞进同一个页面里渲染），
> 所以各家的登录态、Cookie、缓存天生就是隔开的。

> 开源（MIT）。内置的各家 logo 是各自公司的商标，本项目只用于标识服务入口，见 [NOTICE.md](NOTICE.md)。

---

## 安装

**方式一：直接装（推荐）**

到 [Releases](https://github.com/zhangyangeng/AIHub/releases) 下载对应平台的安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `Aihub_x.y.z_x64-setup.exe` | 一键安装，不需要管理员权限，装完桌面和开始菜单都有快捷方式 |
| macOS（Apple Silicon / M 系列，需要 macOS 14 及以上） | `Aihub_x.y.z_aarch64.dmg` | 拖进「应用程序」即可 |

> **Windows**：没有代码签名证书，SmartScreen 可能提示「已保护你的电脑」——
> 点「更多信息 → 仍要运行」即可。
>
> **macOS**：同样没有签名和公证，首次打开会被 Gatekeeper 拦下。
> 两种办法任选：① 在「应用程序」里 **右键点 Aihub → 打开 → 仍要打开**（只需一次）；
> ② 或者执行 `xattr -dr com.apple.quarantine /Applications/Aihub.app`。

**方式二：从源码跑**

需要 Node 22+ 和 Rust 工具链（`rustup` + 平台 C 工具链；Windows 还要单独装 MSVC 生成工具，
`rustup` 不会代装）。两个平台的准备步骤见 [docs/build.md 环境准备](docs/build.md#1-环境准备)——
`cargo` 不在 PATH 上时，`tauri dev` 会在第一条命令就失败。

```bash
git clone https://github.com/zhangyangeng/AIHub.git
cd AIHub
# 这是两个互相独立的包，两个都要装：根目录是 tauri 构建工具，src-ui 是前端
# （vue / vite / sass）。只跑第一条的话前端起不来，会报 sass 之类的缺失。
npm install
npm --prefix src-ui install
npm run tauri:dev
```

第一次编译要等几分钟到十几分钟，之后只重编改动过的部分；改前端是热更新。
打包和发版的细节见 [docs/build.md](docs/build.md)。

**方式三：让 GitHub 帮你构建**

推送到 `main` 或提 PR 时会自动跑检查（Rust 单测、前端类型检查和打包校验）。要出安装包，
推一个 `v*` 标签——会构建 Windows x64 和 macOS arm64、发正式 Release，并生成更新用的
`latest.json`。只想拿 main 上的代码打个包试试，在 Actions 里手动触发 `Build (Tauri)` 即可。

---

## 从旧版升级

v0.3.0 起运行时从 Electron 换成了 Tauri，安装包从 **113 MB 降到约 2 MB**，
装完占盘从 373 MB 降到 5 MB 左右——不再把整个 Chromium 打进包里，改用系统自带的 WebView2。

**代价是各站点要重新登录一次**：旧版的登录态存在 Chromium 的分区格式里，两边的 cookie
存储格式不兼容。

v0.4.0 起有办法绕过去：旧版「导出登录信息」得到的文件，新版可以直接导入
（格式保持字节级兼容，改名之前的 `ai-multi-hub-login` 也认）。
旧版已经删掉、也没导出过的，仍然只能各站重登一次。

能继承的：服务列表、分屏布局、主题、快捷键、休眠设置（都在同一个 `config.json` 里）。

另外两点：

- **macOS 最低要求 14.0**：打包配置里写死了 `minimumSystemVersion`。
- **Windows 需要 WebView2 运行时**：Win11 自带，Win10 基本都随 Edge 装过了。
  极少数精简版 / LTSC 系统上，安装器会自动去微软下载（需要联网，约 1 分钟）。

细节见 [ADR-001](docs/adr/001-electron-to-tauri.md)。

---

## 常用操作

| 操作 | 方式 |
| --- | --- |
| **唤出 / 收起窗口（全局）** | **`Alt+Space`**：任何程序在前面时按下都能把窗口拉到最前（连别的程序的全屏也压得住）；窗口已经在前面时再按一次收进后台。可在 ⚙ 里改成别的组合键或关掉 |
| 切换标签 | 点击标签 |
| 刷新当前标签 | 标签栏右侧 ⟳；焦点在外壳上时 `F5` / `Ctrl+R`，加 `Shift` 强制刷新、忽略缓存 |
| 返回该服务首页 | 标签栏右侧 ⌂ |
| 打开设置面板 | 标签栏右侧 ⚙ |
| 打开开发者工具 | ⚙ → 对应服务行右侧的按钮（独立窗口，排查登录问题很有用） |
| 添加 / 收起服务 | 标签栏右侧 + 或 ⚙，「填名字 + 网址」即可；标签上的 × 只是从顶栏收起，登录态和配置都保留，⚙ 里能放回来 |
| 标签 logo | 每个标签自带内置 logo，**不用点开也有**；没内置图的站点用网站的 favicon 或彩色圆点 |
| 加入 / 移出分屏 | **右键点标签**切换 |
| 调整两栏宽度 | **直接拖动两栏之间的分隔条**（鼠标移到缝隙会变成左右箭头） |
| 两栏宽度均分 | **双击分隔条** |
| 切换当前焦点栏 | 点击已在布局中的标签；或直接点某栏里的页面 |
| 换外观主题 | ⚙ →「外观主题」→ 深色 / 浅色 / 跟随系统（只影响本应用的标签栏和设置面板） |
| 收起标签栏 | ⚙ →「显示标签栏」关掉，站点页面多出 44px。放回来：点托盘（macOS 菜单栏）图标 →「显示 / 隐藏标签栏」 |
| 窗口常驻置顶 | ⚙ →「窗口常驻置顶」，默认开启 |
| 启动时预加载 | **默认关闭**：启动只加载标签栏当前要显示的那几栏。开启后会把所有标签的页面加载一遍，只为了让标签栏显示各站点的真实标题——logo 不开也有 |
| 后台标签自动休眠 | **默认开启**：闲置超过 30 分钟就释放掉页面进程，点回去从原地址恢复。⚙ 里可调 15 分钟 / 30 分钟 / 2 小时 / 不休眠 |
| 导出 / 导入登录信息 | ⚙ →「账号迁移」，换电脑时可以把各站登录态整个搬过去（可加密） |
| 自动更新 | 启动后自动在后台查、下载完在底部提示「立即重启」；也可 ⚙ →「版本与更新」→「检查更新」 |
| 中键点击标签 | 重新加载该标签 |

标签栏右侧会显示当前页面的域名，方便确认登录时到底停在哪个站点。
已经在分屏里的标签会带上「第几栏」的小角标，⇔ 按钮上显示当前栏数。
**选中的标签会加一档底色**，和未选中的拉开距离。

---

## 数据保存在哪里

| 内容 | 位置 |
| --- | --- |
| 服务列表 / 分屏布局 / 各标签上次的网址 / 主题 / 快捷键 / 休眠档位 | `%APPDATA%\Aihub\config.json` |
| 各服务的 Cookie、localStorage 等登录态 | `%APPDATA%\Aihub\WebViews\<服务 id>\` |

想彻底重置某个服务的登录态：⚙ → 对应服务 → 删除 → 「删除并清除登录数据」。
（`%APPDATA%` 通常是 `C:\Users\<你>\AppData\Roaming`，设置面板底部会显示实际路径。）

换电脑：把「导出登录信息」得到的 JSON 拷过去，在新设备上先确认服务列表一致，
再「导入登录信息」，不用重新登录。

> **从 Electron 版升级上来**：Tauri 版刻意沿用同一个配置目录，`config.json` 直接被读走，
> 所以服务列表、分屏布局、主题、快捷键全部保留。旧版的登录态在 `Partitions\<id>\`，
> Tauri 版不碰也不删，新版自己的数据写在隔壁的 `WebViews\<id>\`。

---

## 已知限制

- **不能"一次提问同步发给所有模型"**：这是套壳方案的天然限制。要实现得针对每个网站写注入脚本
  模拟「填输入框 + 点发送」，各家网页改版频繁，维护成本高，本项目不做。
- **分屏只解决"同时看"**，每一栏仍要分别手动输入。最多 4 栏，一栏最小 260px。
- **栏数越多越吃内存**：每栏都是一个常驻进程。默认只加载标签栏要显示的那几栏，
  后台闲置 30 分钟自动回收，但分屏里显示着的不会被回收。
- **部分快捷键只写在提示文字里，从未实现**：`Ctrl+Tab` 切标签、`Ctrl+1~9` 直达、
  页面缩放（`Ctrl+=` / `Ctrl+-` / `Ctrl+0`）。这几个键在早期版本的底部提示里
  就一直列着，但前端和 Rust 端都没有对应处理；焦点在站点页面时按键也落不到外壳。
  刷新请用 ⟳。
  （`Ctrl+,` 开设置已经实现：应用在前台期间会临时注册成系统级快捷键，
  所以焦点在站点页面时也能用；切到别的程序立刻撤销，不占这个键。）
- **⇔ 分屏菜单和外壳右键菜单还没接上**，点了不会有反应；加减分屏栏走「右键点标签」。
  站点页面里的右键是 WebView2 自带的那套，没有应用定制项。
- **macOS 上「每个站点登录态互不干扰」目前没生效**：所有站点共用同一个 cookie 存储，
  同一个网址加两个服务会共享登录。Windows 上是真隔离的。原因和修法见
  [docs/design.md](docs/design.md) 第 9 节。
- **macOS 上渲染引擎是 WKWebKit 不是 Chromium**，各家 SPA 的重前端渲染差异改不了——
  那是系统的 webview。Windows 上不存在这个问题。
- **导出文件等于账号凭证**：别丢到网盘公开目录、别发给别人；建议导出时设个密码。
  迁移后建议在旧设备上退出登录，免得平台风控把「两地同时在线」当异常。
- **不迁移 IndexedDB / Service Worker 缓存**，登录态只覆盖 Cookie 和 localStorage。
- **未签名安装包会触发 SmartScreen 警告**，功能不受影响。

---

## 开发

| 想看什么 | 去哪 |
| --- | --- |
| 内部实现：运行时结构、分屏几何、休眠判定、图标、主题、动效 | [docs/design.md](docs/design.md) |
| 自检与回归：静态检查、Rust 单测、真机自检、Cloudflare 回路 | [docs/testing.md](docs/testing.md) |
| 打包与发版：产物、签名、`latest.json` | [docs/build.md](docs/build.md) |
| 排错 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 为什么迁 Tauri、代价是什么 | [docs/adr/001-electron-to-tauri.md](docs/adr/001-electron-to-tauri.md) |
| 前端框架化的方案、审核与风险 | [docs/architecture/](docs/architecture/) |
| 做了哪些、还剩哪些 | [docs/roadmap.md](docs/roadmap.md) |

常用命令：

```powershell
npm run tauri:dev      # 开发模式（改 Rust 自动重编，改前端热更新）
npm run tauri:test     # Rust 单测
npm run test:ui        # 前端静态检查（IPC 契约 + 类型 + 打包 + 模块图 + 跨语言）
npm run tauri:build    # 出安装包
```

本地构建/验证请用上面的 `tauri:dev` / `tauri:build`，不要直接 `cargo build`——
前端资源是编译期嵌进二进制的，裸 `cargo build` 产出的 exe 没有外壳界面。

仓库里还保留着迁 Tauri 之前那套 Electron 实现（`main.js` / `preload.js` / 根目录 `index.html`），
只做不破坏性的维护，方便对照。**改功能请改 `src-tauri/` + `src-ui/` 那一套**，两边功能不再同步。

欢迎提 Issue / PR。想加站点：先在 `assets/logos/` 里补一张 logo、跑 `npm run icons`，
再在 `src-tauri/src/services.rs` 的 `default_services()` 里加一条。

---

## 许可证与致谢

本项目以 **MIT** 许可证开源，见 [LICENSE](LICENSE)。可以自由使用、修改、商用，保留版权声明即可。

第三方素材的边界（**重要**）：内置的各家 AI logo 是各自公司的商标，本项目只用来标识服务入口，
与这些公司没有合作或背书关系；图标素材的收集整理参考了
[cc-switch](https://github.com/farion1231/cc-switch)（MIT）。详细说明见 [NOTICE.md](NOTICE.md)。
