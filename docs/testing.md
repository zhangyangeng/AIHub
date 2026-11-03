# 自检与回归

改完代码后按需往下跑。前三层不需要打开窗口，越往后越慢也越贵。

---

## 1. 静态检查（秒级，CI 也跑）

```powershell
npm run test:ui
```

串起五件事：

| 子命令 | 盯的是什么 |
| --- | --- |
| `lint:ui` | IPC 契约（前端声明的命令名 / 参数名与 Rust `generate_handler!` 对得上）+ `vue-tsc` 类型检查 + Vite 打包 |
| `test:ui-module` | 把整个前端模块图按真实顺序加载一遍，专抓「模块顶层求值就抛错」导致的白屏 |
| `test:api-result` | 命令失败时返回 `{ok:false,error}` 而不是抛出——业务代码都没套 try，语义变了会静默失效 |
| `test:login-crypto` | Rust 加密的登录文件 Node 也能解 |
| `test:cf-guard` | Cloudflare 守卫的状态机：并发、返回点不被覆盖、认输不无限刷 |

> `test:cf-guard` 需要全局 playwright：`npm install -g playwright && npx playwright install chromium`。
> 其余四项零依赖。

**为什么单独做契约检查**：命令名拼错这件事类型系统看不出来，要等用户点到那个按钮才炸。
`tools/check-ipc-contract.js` 直接读 `src-ui/src/api/index.ts`，把每个 `invoke('xxx', {…})`
的字符串和参数名拿去跟 Rust 的 `generate_handler!` 比对。

**为什么单独做模块图检查**：白屏在 CI 里看不出来——构建能过、进程能起，只是 `#app` 里空的。
真出现过一次：某个 composable 在模块顶层取 Pinia store，而 `main.ts` 在 `createPinia()`
之前就 import 了它，整个模块图求值失败。`tools/ui-module-smoke.js` 会按真实顺序加载模块，
任何一层抛错都会当场炸出来。

## 2. Rust 单测（十几秒）

```powershell
npm run tauri:test
```

73 个，覆盖：

- 分屏几何（权重和为 1、最小栏宽、田字格不重叠、右边缘贴合）
- 配置读写与 v3→v4 迁移
- 内置服务列表升级（扣子→豆包、补站点、不碰用户自建服务、已是最新版不重复改）
- 休眠豁免判定（分屏中 / 出声中 / 有输入都算豁免）
- 登录文件格式与 scrypt + AES-256-GCM，含两份**由 Node 按 Electron 版算法生成**的 fixture
  ——「老文件还能导入」这条承诺就靠它们钉住
- 托盘不变式（该有的时候必须在，否则用户会掉进「什么都点不到」的状态）

## 3. 真机自检

三套，各自盯一类只有真窗口才暴露的问题。都要在 debug 构建下跑，
并且**必须配 `AIHUB_CONFIG_DIR` 指向一个空目录**——`config_dir()` 写死了 `%APPDATA%/Aihub`，
换 identifier 也不会变，不隔离就会读到并改动你真实的登录态。

### 3.1 拖拽分屏 / 标签换顺序

```bash
AIHUB_SELFTEST=tools/tauri-drag-selftest.js \
  cargo run --manifest-path src-tauri/Cargo.toml
```

脚本在外壳里合成「按下 → 移动 → 松手」，跑完在 stderr 上打印
`[selftest] 分栏 OK … / 换顺序 OK … / Esc 取消 OK`，失败打印 `失败: …` 并抛错。
它只是临时改布局和标签顺序，**结束（含失败）一定还原**。

拖拽以前是「合成事件测不到」的典型，只能注入真实鼠标才能验。Tauri 版把标签拖拽改成
自己跟踪鼠标事件之后（原因见 [design.md](design.md) 第 3 节），这条链路才第一次能用合成事件测。

### 3.2 登录态导出 / 导入

```bash
cd src-tauri
SCRATCH="$TEMP/aihub-mig" && rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
AIHUB_CONFIG_DIR="$SCRATCH" \
  TAURI_CONFIG='{"identifier":"io.github.wrysmile.aihub.migtest"}' \
  AIHUB_LOGIN_EXPORT_TO="$SCRATCH/export.json" \
  AIHUB_SELFTEST=../tools/login-migration-selftest.js cargo run
```

| 程 | 盯的是什么 |
| --- | --- |
| ① 导出 | **死锁**。建临时 webview、等页面、eval、读 cookie 四件事都是「阻塞当前线程等主线程派发回调」，命令写成同步的就会自己等自己 |
| ② 预检 | 自己导出的文件自己认不认得，服务匹配对不对得上 |
| ③ 写回 | `set_cookie` 会不会被 WebView2 拒，失败数必须是 0 |
| ④ 复查 | **写回有没有真的落盘**。③ 只证明调用返回了 Ok —— 而临时视图写完就销毁，不再读一遍就分不清「写进去了」和「调用成功但随视图一起没了」 |

> **两个环境变量必须同时给。** `TAURI_CONFIG` 换 identifier 只避开单实例锁；
> `AIHUB_CONFIG_DIR` 才是真正换数据目录的那个。只换 identifier 的话，
> 这条自检会把你真实的登录态明文导到磁盘上。
>
> **而且必须在冷 profile 上验。** 热 profile 会掩盖真 bug：踩过一次——
> 「建完视图立刻读 cookie」在热 profile 上碰巧能读到（磁盘上本来就有），冷 profile 上是 0 条。
> 而「导出了 0 条 cookie」和「这个站点没登录」在返回值上一模一样。

### 3.3 Cloudflare 守卫回路

```bash
bash tools/cloudflare-guard-loop.sh                     # 期望红（没有守卫时）
CF_EXPECT=green bash tools/cloudflare-guard-loop.sh     # 期望绿
CF_FIXTURE_MODE=stuck CF_EXPECT=stuck \
  bash tools/cloudflare-guard-loop.sh                   # 期望「认输并提示」，且只导航一次
```

它跑的是**真 app**：`tools/cloudflare-fixture-server.js` 按真实响应回放
（`403` + `cf-mitigated: challenge` + 真实挑战页），自检脚本把 fixture 站点挂进站点 webview，
页面再把自己**渲染出来的文字**回传给服务器——判红绿用的就是服务器那份轨迹。

| 模式 | 轨迹 | 含义 |
| --- | --- | --- |
| （没有守卫） | `XHR 403 → 页面渲染 Route Error (403)` | 红：原始 bug |
| `normal` | `XHR 403 → 文档导航 → clearance 200 → 回原页 → 重试成功` | 绿：修复生效 |
| `stuck` | `→ 文档导航 1 次 → 闸门拦住 → 提示条` | 绿：过不去时收手 |

三个前提：

1. **不能有另一个 aihub 在跑**：单实例插件会让这次的实例直接退出（表现为「什么都没发生」）。
2. **只在 debug 构建里能跑**：`AIHUB_SELFTEST` / `debug_eval` 都是 `#[cfg(debug_assertions)]`。
3. **只在 macOS 上验过**。Windows / WebView2 上的真实效果没有验过——那边过不过盾
   由出口 IP 和客户端指纹决定，不是应用层能保证的。

### 3.4 守卫自己的状态机（不用构建 app）

```bash
npm run test:cf-guard     # 也包含在 npm run test:ui 里
```

上面那条回路验的是「挑战能不能被挪进文档里跑完」，要起真窗口、每轮等 14 秒，
验不动并发和状态掉落。`tools/cloudflare-guard-strand-test.js` 把同一份
`challenge-guard.js` 注入 Chromium（WebView2 就是这个内核），拿 fixture 跑六档：

| 用例 | 盯的是什么 |
| --- | --- |
| 单发挑战 | 基本回路：过盾后回到原页 |
| 同一 URL 并发两次 | v0.3.3 的线上 bug，见 [design.md](design.md) 第 8 节 |
| 两个不同 URL 同时被拦 | 分键的返回点不会互相覆盖 |
| 只剩 tried、returns 没了 | `home` 兜底仍然能把人送回去 |
| 一串接口接连被拦 | 总闸门封顶，不把用户来回甩 |
| 文档导航也过不了盾 | 只导航一次 + 可点的返回口，不无限刷 |

### 3.5 macOS 标题栏

```bash
cargo build --manifest-path src-tauri/Cargo.toml
bash tools/check-macos-titlebar.sh            # 也可以传路径，量 release 那份
```

Tauri 在 macOS 上默认把窗口建成 `FullSizeContentView`，系统标题栏会压在内容顶上
——**几何算得没错，错的是「内容区从哪儿开始」**，光看代码看不出来。
这个脚本量的是窗口内外尺寸差：差够一个标题栏的高度（约 28px），
才说明内容区真的在标题栏下方、44px 的标签栏是完整露出来的。

## 4. Electron 回退版

```powershell
$env:AIHUB_SMOKE='1'; npm start
```

279 项断言，会真的打开窗口、依次切换每个标签、真实加载各站点。
它只覆盖 Electron 那套实现，Tauri 版的改动它一无所知，**别拿它当门禁**。

碰真实账号的部分只读（只导出、只做「不减少」的断言）；清空 Cookie、写本地存储这类
破坏性验证只在临时服务上做，做完连分区一起删掉。开跑前会把 `config.json` 整份存下来，
结束时原样写回。
