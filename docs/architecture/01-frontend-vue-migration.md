# Aihub 前端框架化重构方案

> 状态：待审阅
> 日期：2026-10-31
> 目标：把 114KB 的原生单文件 `src-ui/index.html` 重构为 Vue 3 + Vite + TypeScript + Pinia 工程，Rust 后端零改动。

---

## 0. 背景与结论（速览）

### 关键约束：`src-ui/` 目录必须保留

Rust 端用 `include_str!("../../src-ui/challenge-guard.js")` 在**编译期**嵌入 Cloudflare 挑战守卫脚本
（`src-tauri/src/views.rs:190`）。因此 `challenge-guard.js` 必须留在 `src-ui/` 根，路径不能动，
否则 Rust 编译失败。这决定了：Vite 工程必须落在 `src-ui/` 目录内，而非另起目录。

前端资源地图（哪些要保留原样、哪些要重构）：

| 文件 | 归属 | 处理 |
|---|---|---|
| `challenge-guard.js` | Rust 编译期嵌入 | **原样保留在 src-ui/ 根**，不动 |
| `icons.js` | 运行时数据（window.AIHUB_ICONS） | 原样保留，作为静态脚本引入 |
| `icons/`（119 个图标） | 被 icons.js 相对路径引用 | 放 public/，构建时拷贝到 dist |
| `build/icon.png` | 品牌图标 | 放 public/，构建时拷贝 |
| `error.html` | 站点加载失败页 | 放 public/，构建时拷贝 |
| `index.html` | 外壳 UI | **重构为 Vue 工程入口** |

### 为什么要重构

- 现状：`src-ui/index.html` 是 **2893 行 / 114KB** 的单文件，CSS（951 行）+ 逻辑（1732 行）全部内联，零组件化、零类型、零构建。
- 用户主要做前端开发，维护一个 114KB 原生单文件成本高、易出错。

### 为什么可以放心重构（已验证）

| 关切点 | 结论 |
|---|---|
| 省内存（核心诉求） | **不受影响**。省内存靠 Rust 端 `hibernate()` 休眠 + 系统 WebView2，与前端框架无关 |
| 编译产物体积 | **更小**。实测 Vue3+Vite 产物 ~66KB（含运行时），原生源码 128KB |
| Rust 端改动 | **零改动**。外壳通过 `WebviewUrl::App("index.html")` 加载，只需改 `frontendDist` 路径 |
| 协议 | **MIT**，可自由 fork/修改/私有化，只需保留版权声明 |

### 定案选型

- **框架**：Vue 3（组合式 API）
- **构建**：Vite 6
- **语言**：TypeScript
- **状态管理**：Pinia

---

## 1. 现状诊断：9 大功能模块

读完整份代码后，逻辑可归为 9 个天然有边界的模块：

| # | 模块 | 代码位置 | 核心职责 |
|---|---|---|---|
| 1 | 标签栏 | `tabNodeFor` / `renderTabs` / `syncTab` | 渲染标签、拖拽排序、中键重载、右键分屏、收起 |
| 2 | 拖拽分屏 | `startTabDrag` ~ `applyDrop` / `slotRects` | 鼠标拖标签 → 田字格投放区 → 分屏 |
| 3 | 分隔条 | `renderLayout` / `onDividerMove` | 拖动调整栏宽、双击均分 |
| 4 | 设置面板 | `setOverlay` / `serviceRow` / `renderServiceList` | 服务增删改、删除确认、收起/放回 |
| 5 | 添加 AI 面板 | `openAddPanel` / `closeAddPanel` | 从内置目录加站点 |
| 6 | 偏好设置 | `preload` / `ontop` / `tabbar` / `nap` / `theme` / `hotkey` | 预加载、置顶、标签栏显隐、休眠、主题、快捷键录制 |
| 7 | 登录迁移 | `doImport` / `exportLogin` | 登录态导出/导入（含密码、加密） |
| 8 | 更新 | `wireUpdate` | 检查/强制更新、进度提示 |
| 9 | 外壳基础设施 | `toast` / `syncViewYield` / `statusOf` / `applyState` | Toast、视图让位仲裁、状态同步、右键菜单 |

**最大的技术债**：`syncViewYield()`（视图让位仲裁）和 `status` Map（标签状态就地更新）是「全局状态 + 手动 DOM 同步」的典型，是重构时最需要设计好的地方。

---

## 2. 目录结构

```
src-ui/                        # 保持目录名不变，减少 Rust 端改动
├── index.html                 # Vite 入口（替换原 2893 行文件）
├── src/
│   ├── main.ts                # createApp 挂载 + Pinia 注册
│   ├── App.vue                # 根组件：布局骨架 + 面板开关
│   ├── api/
│   │   ├── index.ts           # 复用现有 api-shim.js（转 TS，加类型）
│   │   └── types.ts           # window.api 的类型定义（几十个方法的契约）
│   ├── stores/                # Pinia
│   │   ├── state.ts           # 全局 state（services/activeId/panes/...）
│   │   ├── status.ts          # 标签状态 Map（loading/error/hibernated）
│   │   └── overlay.ts         # 视图让位仲裁（overlayOpen/addPanelOpen/dragYielding）
│   ├── composables/
│   │   ├── useToast.ts        # toast / toastAction
│   │   ├── useTabDrag.ts      # 标签拖拽（鼠标事件跟踪，不用 HTML5 拖放）
│   │   └── useDividerDrag.ts  # 分隔条拖拽（setTimeout 节流，不用 rAF）
│   ├── components/
│   │   ├── TabBar.vue         # 标签栏 + 单个 Tab
│   │   ├── DropZones.vue      # 田字格投放区（slotRects 逻辑）
│   │   ├── SplitDividers.vue  # 分隔条
│   │   ├── SettingsPanel.vue  # 设置面板 + ServiceRow
│   │   ├── AddPanel.vue       # 添加 AI 面板
│   │   ├── HotkeySection.vue  # 快捷键录制
│   │   └── MigrateSection.vue # 登录迁移
│   └── styles/
│       ├── variables.css      # 现有的 CSS 变量（原样搬）
│       └── base.css
├── api-shim.js               # 保留原样（或转 TS 进 api/）
└── icons.js                  # 保留原样（内置图标表）
```

---

## 3. 关键设计决策

### 决策 1：状态管理用 Pinia，收拢全局状态

现有代码有 47 个全局 `let/const` + 一个 `status` Map + 三个「让位」布尔开关。

- `state.ts`：主状态（services / activeId / panes / weights / preload / theme / hotkey / version ...）
- `status.ts`：标签状态 Map（loading / error / favicon / url / title / hibernated）
- `overlay.ts`：视图让位仲裁，核心是 `syncViewYield` 逻辑（三开关求或 → 只在变化时发 IPC）

### 决策 2：拖拽逻辑用 composables，不塞进组件

标签拖拽（`useTabDrag`）和分隔条拖拽（`useDividerDrag`）是命令式、高频、依赖全局 mousemove 的逻辑，要挂 `document.addEventListener('mousemove')`，生命周期独立于组件，放 composable 最干净。

### 决策 3：三个「雷区」必须原样保留（不能顺手优化）

1. **分隔条节流用 `setTimeout`，不用 `requestAnimationFrame`**
   （原注释：窗口被遮挡时 Chromium 暂停 rAF，拖拽会卡死）

2. **标签拖拽用鼠标事件跟踪，不用 HTML5 拖放**
   （原注释：Tauri 的 wry 在 macOS 上吞掉了 HTML5 拖放事件）

3. **`slotRects()` 田字格算法必须和 Rust 端 `compute_grid` 严格一致**
   （原注释：否则拖拽预览和真实布局对不上）

---

## 4. 迁移步骤（6 个可验证阶段）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0** | 搭骨架：Vite + Vue + Pinia + TS，接 api-shim/icons，改 `frontendDist` | `tauri dev` 能起，外壳加载出空页面 |
| **P1** | 外壳基础设施：`window.api` 类型、state store、toast、`syncViewYield` | 能读到 state、toast 可用 |
| **P2** | 标签栏：TabBar + 激活/中键/右键 + 收起 | 标签能切、能收 |
| **P3** | 拖拽分屏 + 分隔条（含三个雷区） | 能拖标签分屏、能拖分隔条调宽 |
| **P4** | 设置面板 + 添加面板 + 偏好设置（快捷键录制、主题、休眠） | 面板全功能可用 |
| **P5** | 登录迁移 + 更新 + 右键菜单 | 全功能对齐，跑通 lint + 构建 |

每阶段独立可跑，避免「搬了一大半跑不起来」。

---

## 5. `tauri.conf.json` 改动（唯一需要碰配置的地方）

```jsonc
"build": {
  "frontendDist": "../src-ui/dist",     // 从 "../src-ui" 改成 Vite 输出目录
  "beforeDevCommand": "npm run dev",    // dev 模式自动起 Vite
  "devUrl": "http://localhost:1420"     // dev 模式外壳从这里加载
}
```

Rust 端 `src-tauri/` 一个字符都不用动。

---

## 6. 风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| 三处「雷区」被无意改写 | 拖拽/节流/田字格算法 | 迁移时逐字保留原注释，写进测试 |
| 状态同步语义偏差 | `status` Map 就地更新 vs Pinia 响应式 | P2 重点验收标签状态刷新 |
| 视图让位仲裁顺序 | 三个开关的「或」逻辑 | 收进 `overlay.ts` store，加单测 |
| 上游合并冲突 | 重构后前端与上游分叉 | 前端自己维护，Rust 端只 cherry-pick 上游改动 |
| 图标表依赖 | `icons.js` 是运行时注入的全局 `window.AIHUB_ICONS` | 保持原样引用，不重构 |

---

## 7. 待确认项（审阅时请回复）

1. **TypeScript 严格程度**：`strict: true`（推荐）还是放宽？
2. **`api-shim.js` / `icons.js` 是否转 TS**：建议 `api-shim` 转 TS（有类型收益），`icons.js` 保持原样（纯数据，无收益）。
3. **是否保留 `src-ui/` 目录名**：建议保留，`tauri.conf.json` 改动最小。
4. **迁移节奏**：一次到位，还是先 P0~P3 出个可用的「标签栏 + 分屏」版本给你看效果？
