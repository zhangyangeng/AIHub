# 实现说明

这份文档讲的是「它内部是怎么work的」：为什么某些地方必须那样写、踩过什么坑。
只想用的话看 [README](../README.md) 就够了。

---

## 1. 运行时结构

窗口本身是一个普通网页（`src-ui/`，加载进外壳 webview），只负责画顶部 44px 的标签栏、
工具栏和设置面板。每个 AI 服务是**独立的子 webview**（`windows.add_child`），
位置由 Rust 侧按分屏几何算好，正好从标签栏下方开始。

这样做的直接收益：

- 没有 `iframe`，所以 `X-Frame-Options`、CSP 的 `frame-ancestors` 都拦不住它
  ——这也正是不能直接用 `<iframe>` 的原因。
- 每个服务有自己的数据目录（`%APPDATA%\Aihub\WebViews\<服务 id>`），
  Cookie / localStorage / 登录态天然隔离，且写到磁盘、下次启动保持。
- 站点 webview 只被授予了「不能调命令」的权限（`src-tauri/capabilities/`），
  只有外壳能调 Rust 命令。

## 2. 加载与休眠

**默认只加载标签栏当前要显示的那几栏**：启动时只给分屏里的栏和当前激活的标签建视图，
其余标签懒创建——点过才占一个进程。标签栏上的名字和 logo 不依赖页面加载
（见第 4 节），所以不点开也是全的。

**启动时预加载**是可选项（默认关闭）：开启后每隔 350ms 建一个服务的视图，
把所有标签的页面都加载起来。视图不挂到窗口上，所以不占显示区域、也不影响分屏，
换来的是各站点的真实标题能提前显示。代价是启动即多个进程 + 多次真实网络请求。

**后台休眠**（默认开启，30 分钟）会把闲置标签的 webview 整个释放掉。
下面这些情况一律不休眠：

- 在分屏布局里显示着的
- 当前激活的那一栏
- 正在出声的（语音 / 朗读）
- 正在加载的
- 开着开发者工具的
- **输入框里还有没发出去的字的**：回收前会往页面里探一次，探测超时或出错都按
  「有输入」处理——宁可多占一会儿内存，也不吞掉写了一半的提示词
- **有第三方登录弹窗开着时，这一轮整个不回收**：弹窗的回调要落回原标签，
  把标签本体收掉这次登录就白做了

点回一个休眠的标签就自动恢复，起始地址取自 `config.lastUrls`，
所以「休眠前停在哪儿就回到哪儿」。标签栏上的名字来自前端缓存的标题、
图标来自内置本地 logo，两者都和页面进程的生死无关，
整个过程标签栏不会闪、不会掉图、不会变回默认名。

## 3. 分屏几何

这是最需要解释的一块，因为站点 webview 会盖住窗口自己的网页。

**模型**：`panes: [服务 id…]`（最多 4 栏）加 `weights: […]`（水平占比，和为 1），
存在 `config.json` 里。

**算几何**：Rust 侧按权重把客户区宽度切成 N 栏，栏与栏之间留 4px 缝隙
（只有一条细线那么宽，整块界面看起来才是一体的）。最后一栏直接吃掉取整误差，
保证右边缘严格贴合窗口。计算和执行刻意分开：计算要读 `ViewManager`（需要锁），
执行要 `add_child`（会阻塞等主线程），两件事必须发生在锁的两侧，否则就是死锁。

**拖拽**：那 4px 缝隙里没有任何视图，所以外壳页面能收到鼠标事件。
缝隙太细压不准，几何里额外带 `hitX` / `hitWidth`，热区比缝隙两侧各宽出 5px（共 14px），
视觉上仍是中间那条细线。拖动时把指针 x 坐标报给 Rust，Rust 重算权重并立刻改边界；
一次拖动只走轻量的 `layout:drag`，不重建标签栏，所以是跟手的。

拖动只调整相邻两栏、两者之和不变，且两栏都不小于 260px（`MIN_PANE_WIDTH`）。
双击分隔条把相邻两栏拉回等分。

**三个必须保持住的设计约束**：

1. **节流用 `setTimeout`，不用 `requestAnimationFrame`**。窗口被别的窗口遮挡时
   Chromium 会停止出帧，rAF 不再触发，拖拽会直接卡死。现在用时间戳 + `setTimeout`。
2. **标签拖拽用鼠标事件，不用 HTML5 拖放**。wry 会把 macOS 的拖放目标回调整个接管
   （tauri-apps/wry#1829、tauri-apps/tauri#14373），页面内的非文件拖拽不会转发给 WebKit。
   自己跟踪鼠标事件反而更稳：按住期间 AppKit 会把 mousemove 送回「按下的那个视图」。
   顺带的好处是这条链路可以用合成事件测（`tools/tauri-drag-selftest.js`）。
3. **`slotRects` 田字格必须与 Rust 的 `compute_grid` 一致**。外壳要按 Rust 广播的几何
   摆分隔条和投放区，两边算出来的格子差一个像素，投放区就会错位。

**硬边界而非橡皮筋**：到 260px 就停住，不回弹。多栏布局是会被直接提交的，
视觉上再晃一下反而让人以为宽度没生效。真要回弹需要一套带速度传递的弹簧，眼下不值这个复杂度。

## 4. 图标

内置站点自带本地 logo，不依赖网站把 favicon 传回来。

`tools/build-icons.js` 把 `assets/logos`（来源 cc-switch，MIT）里的图标复制成两套：

- 根目录 `icons/` + `icons.js`：Electron 回退版用（`build.files` 白名单）
- `src-ui/public/icons/` + `icons.js`：Vite 原样复制进 `dist`，Tauri 外壳用

索引里有三张表：服务 icon 字段 → 文件、域名 → 图标、key 别名。

**取值顺序**：服务自带的 icon 字段 → key 别名 → 域名匹配 → 名字匹配；
命中就用本地图，没命中才退回网站 favicon，再没有就用服务颜色的小圆点。
所以标签栏一上来就是各家 logo，不用点开、不用等网站响应，换 favicon 风格时也不会忽大忽小。

**不给 logo 垫白底**。纯黑 / `currentColor` 的 logo（Kimi、ChatGPT、Grok 这类）
在深色标签栏上会看不见，纯白 / 浅灰的在浅色主题下会糊掉。
脚本按每个 SVG 的颜色（亮度 + 饱和度）判断，会看不见的才生成反白 / 压深变体，
放在 `icons/dark/`、`icons/light/`；带品牌色的（DeepSeek 蓝、Claude 橙等）原样保留。

前端按 `prefers-color-scheme` 自动挑对应那一套，主题一变就换图。

## 5. 主题

主题存在 `config.json` 的 `theme` 字段（`dark` / `light` / `system`）。
Rust 侧把它交给**窗口级**的 `window.set_theme()`，于是窗口标题栏、滚动条、
以及外壳页面里的 `prefers-color-scheme` 全都跟着变——外壳样式表只要用媒体查询写配色即可，
不需要额外维护「当前主题」的类名，也就没有「设置里切了但页面没跟上」这种同步问题。

配色变量定义在 `src-ui/src/styles/variables.css`：深色是默认值，
浅色在 `@media (prefers-color-scheme: light)` 里覆盖一遍。

服务页面本身的深浅色**不受这个开关控制**：那是各家网站自己的事情。
所以「浅色主题」只让本应用的标签栏和面板变亮。

主题切换时，站点视图的首帧底色也会跟着换（深色 `#12141a` / 浅色 `#ffffff`），
免得出现大面积白闪或黑闪。浅色下面板、卡片、输入框一律纯白不透明——
半透明会透出后面的滚动内容，看着发灰。

## 6. 动效规范

所有动效集中在一组令牌里，写在 `src-ui/src/styles/variables.css`，不允许在别处现编数值。

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--dur-1` | `120ms` | 按压 / 悬浮反馈 |
| `--dur-2` | `180ms` | 小元素进出（提示条、淡入） |
| `--dur-3` | `240ms` | 面板、弹层 |
| `--dur-exit` | `150ms` | 退出（永远比进入短，感觉更跟手） |
| `--ease-out` | `cubic-bezier(.23, 1, .32, 1)` | 进入与退出 |
| `--ease-in-out` | `cubic-bezier(.77, 0, .175, 1)` | 原地形变 |
| `--ease-drawer` | `cubic-bezier(.32, .72, 0, 1)` | iOS 抽屉曲线（滑块、面板落位） |

几条硬规矩：

1. **只动 `transform` / `opacity`**，跳过布局与重绘。绝不 `transition: width/height/top/left`，
   也绝不 `transition: all`。分隔条变粗用 `scaleX`，主题滑块用等宽格子 + `translateX`。
2. **UI 上永远不用 `ease-in`**：它起步慢，正好拖在你盯着的那一刻。
3. **进出同路**：设置面板从下方淡入、也向下方淡出；提示条从下方进来、也从下方出去。
4. **标签栏点得频繁，所以几乎不动画**：只有近乎察觉不到的颜色过渡和按压回弹（`scale(.97)`）。
5. **标签栏就地更新，不整条重建**：标题 / favicon / 加载状态来得非常频繁，
   整条重建会重排 + 重放动画，看起来就是卡顿 + 闪。标签列表按 `key` 复用节点。
6. **尊重系统设置**：`prefers-reduced-motion: reduce` 下保留淡入淡出、去掉位移与缩放；
   `prefers-reduced-transparency: reduce` 下遮罩改不透明。
7. 悬浮类动效统一包在 `@media (hover: hover) and (pointer: fine)` 里。

## 7. 登录态导出 / 导入

实现在 `src-tauri/src/login.rs`。文件格式和 Electron 版**字节级兼容**，
所以 v0.2.x 导出的文件（`format` 是旧名 `ai-multi-hub-login`）可以直接导入。

登录态由两部分组成，导出 / 导入就是分别搬运这两部分：

1. **Cookie**：通过 `webview.cookies()` 读取。**HttpOnly 的会话令牌也能读到、也能写回**
   （`document.cookie` 拿不到这些，所以必须放在 Rust 侧做），
   而且是整个数据目录所有域名一起导出，第三方登录留下的 Cookie 也会跟着走。
2. **页面本地存储**（localStorage / sessionStorage）：只能在该服务的页面里用 JS 读写，
   所以导出时会给没打开过的服务临时建一个视图，读完立刻销毁。

导入顺序是「先写 Cookie → 再写本地存储 → 刷新视图」，同名项覆盖、不影响没导出的服务。
导入前会先解析文件并弹一个确认块，列出每个服务有多少条数据。

**服务匹配优先级**：id + 完整网址都一样 → 完整网址一样 → id 一样 → 同域名。
最后那条「同域名」的兜底很关键：同一个站点完全可能被加成两个标签，
只按域名匹配会把数据写进另一个服务的数据目录，所以一个服务只接受一条导入记录，
测试里专门放了一个同域名的「诱饵服务」来盯这个回归。

**文件等于明文密码**，所以有一层可选加密：`scrypt` 派生密钥 + `AES-256-GCM` 加密整个负载
（密码错误时 GCM 校验直接失败，不会写入半截数据）。不填密码就是明文 JSON。

**已知缺口**：

- 导出文件里不带 `hostOnly` 标记。host-only 的唯一判据是 Cookie 的 Domain 有没有前导点，
  而 `cookie` crate 的 `domain()` 和 `domain_raw()` 都会把点剥掉，这个信息在 wry 这一层拿不到。
  宁可不写也不瞎填：填错了会让导入端把域 Cookie 钉死在单个主机上，子域名的登录态当场作废。
  实际影响是导入后一律按域 Cookie 还原（更宽松），登录本身不受影响。
- 不含 IndexedDB 和 Service Worker 缓存。这几个站点的登录态都在 Cookie 和 localStorage 里，
  缓存属于可再生的内容。真遇到只在 IndexedDB 里存令牌的站点，这个功能搬不动它。

## 8. Cloudflare 挑战守卫

登录 ChatGPT 时如果撞上 Managed Challenge，页面会死在
`Route Error (403): "<!DOCTYPE html>…Just a moment…"`——挑战落在一次 XHR 上，
而挑战页**必须在文档里才能跑起来**，XHR 里没有任何东西会执行它。

`src-ui/challenge-guard.js`（由 `views.rs` 用 `initialization_script` 注入每个站点 webview）
把它挪回文档里真正跑一次，过盾后再把用户送回原来那一页；同一个 URL 只自动重放一次，
拿不到 clearance 就停手并挂一条提示，**绝不无限刷新**。

修这个 bug 时顺带查清了一件一直没被证实的事：`application/json` 这种非 HTML 文档上，
document-start 注入脚本照跑、`DOMContentLoaded` 照触发、同源 sessionStorage 照样带得过去。
所以「停在 JSON 上回不去」从来不是注入没生效。

**v0.3.3 踩过的坑**：页面对同一个接口并发发两次请求，两个 403 前后脚到：
第一次记下返回点并发起顶层导航，第二次撞上重放闸门——而闸门那条路当时会顺手
`delete state.return` 把返回点擦掉。可导航已经在路上了，新文档里一个返回点都没有，
用户就永久停在 `/backend-api/…` 那坨原始 JSON 上（站点 webview 没有地址栏也没有后退按钮）。

修法是三件事：返回点按**目标 URL** 分键、认输时**绝不**碰返回点、
每份文档只允许发起一次顶层重放。

## 9. macOS 上的三处特殊性

**标题栏**：Tauri 在 macOS 上默认把窗口建成 `FullSizeContentView`
（tauri-runtime-wry 的 `TitleBarStyle::Visible` 分支，为了绕开 tauri#3914），
内容视图铺满整个窗口框，而系统标题栏还是那条不透明的——它直接压在内容顶上：
44px 的标签栏只剩下十几 px 露出来，收起标签栏后站点页面顶部 28px 也会被盖住且点不到。
`src-tauri/src/macos.rs` 在建 webview 之前把这一位摘掉，内容区回到标题栏下方。
代价是 tauri#3914 那个「开着 devtools 缩放窗口会错位」的老问题会回来，日常使用无感。

**页面内拖放**：见第 3 节第 2 条。另外站点 webview 必须 `disable_drag_drop_handler()`，
否则 Tauri 那套原生处理器会把文件 drop 直接吃掉、页面上传区收不到（`src-tauri/src/views.rs`）。

**登录态隔离目前是坏的**：mac 侧只设了 `.data_directory()`，而 wry 在 macOS 上根本不看这个字段
（它只被 tauri-runtime-wry 当作 WebContext 的 map key），真正决定存储的是
`WebViewBuilder::data_store_identifier()`——仓库里一次都没调用，于是 wry 落到
`WKWebsiteDataStore::defaultDataStore`，全局一个 jar。

后果是：同一个网址加两个服务（比如两个 ChatGPT 账号）会共享登录态。
Windows / WebView2 走数据目录，是真隔离的。
修法是给 builder 传一个从服务 id 稳定派生的 16 字节 identifier（该 API 需要 macOS 14+）。
复现：加两个同源服务，在一个里 `document.cookie='x=1'`，看另一个读不读得到。

## 10. 渲染差异与上游 bug

- **macOS 上渲染引擎是 WKWebKit 不是 Chromium**。各家站点都是重前端 SPA，
  渲染差异改不了——那是系统的 webview。Windows 上不存在这个问题（WebView2 就是 Chromium 内核）。
- **分屏依赖 Tauri 的 unstable 特性**。已知上游 bug（tauri#10131 / #11170）会让子 webview
  在反复缩放 / 最大化还原后位置飘，本项目用「每个窗口事件都重算绝对坐标压回去」绕过。

## 11. 配置与内置站点迁移

**配置文件**：`%APPDATA%\Aihub\config.json`。Tauri 版刻意沿用 Electron 版的同名路径，
为的是让老配置直接被继承，不用写搬家逻辑。解析失败时会把坏文件备份成 `config.json.bad`
再退回默认值。

**登录态目录刻意换了名字**：Electron 用 `Partitions\<id>`（Chromium 分区格式），
Tauri 用 `WebViews\<id>`（WebView2 格式）。两套格式不兼容，放同一个目录只会互相污染，
所以 Tauri 版既不读也不删旧目录。

**内置站点列表带版本号**（`SERVICES_VERSION`）。老版本配置一读进来就自动升级：

- 最初那版内置的 Coze（扣子）被豆包取代：`panes`、`activeId`、`lastUrls` 里的 `coze`
  一起改名成 `doubao`，并把它原来的数据目录排进待清理队列。
- 补上新增的内置站点，并给每个内置服务补上 `icon` 字段。
- 顺序整理成「内置站点按默认顺序在前，用户自己加的服务按原顺序在后」。
- **只动内置服务**：用户自己加的服务、以及被改过网址的内置服务都不会被删或改地址。

升级只在启动时做一次，之后把 `servicesVersion` 写回配置，所以不会反复搬动。
单测里专门盯「已是最新版不重复改动」「用户自建的 coze 不动」这两条。
