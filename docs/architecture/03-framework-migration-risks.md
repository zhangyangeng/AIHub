# 框架化风险复查：vanilla → Vue 后语义变化点

> 复查时间：2026-11-03
> 背景：真机联调时暴露了几个「原生单文件没问题、搬到 Vue 后悄悄失效」的问题（Pinia 顶层实例化、`window.api` 未赋值等）。这份文档系统排查**同类风险**——哪些原生逻辑依赖了 vanilla 才有的机制，迁移成 Vue 后语义变了。
>
> 结论：已修复 4 处致命问题（见 §一）；另修复 1 处主题相关缺陷（§2.1，已随上游 `fix: 主题切换后深浅配色不生效` 一并解决）；剩余 **3 个「疑似/待验证」的语义变化点**（见 §2.2~2.4）。

---

## 一、已确认并修复的「原生 OK、Vue 会炸」问题

| # | 问题 | 原生为什么 OK | Vue 为什么炸 | 状态 |
|---|---|---|---|---|
| 1 | Pinia store 在模块顶层实例化（`useTabDrag.ts`） | 无模块系统，全局 `state` 对象随时可用 | ES 模块在 `createPinia()` 之前求值，抛 `getActivePinia()` | ✅ 已改 `() => useAppStore()` 延迟解析 |
| 2 | `window.api` 从未赋值（`api/index.ts`） | `api-shim.js` 主动挂全局 | `export const api` 只导出、没挂 `window.api`，组件直接调 `window.api.xxx` 全 undefined | ✅ 已补 `window.api = api` |
| 3 | 组件直接调 `window.api.xxx`（34 处） | 全局可用 | 依赖第 2 条的赋值，且类型声明 `interface Window` 掩盖了运行时缺失 | ✅ 已统一为 `import { api }` |
| 4 | CSP 未放行 HMR 的 WebSocket | 原生无 HMR | Vite 热更新通道被 `connect-src` 拦截 | ✅ 已补 `ws://localhost:1420` |

---

## 二、语义变化点（原生逻辑搬到 Vue 后可能悄悄失效）

### 2.1 【已修复】主题切换后，内置 logo 不会换成对应深浅色变体

**原生行为**（`index.html` 1760-1783）：

```js
// 点主题按钮
state.theme = res.theme;
renderTheme();          // 摆滑块
renderTabs();           // ← 关键：重画标签栏，logo 变体（黑↔白）跟着换
renderServiceList();    // ← 重画服务列表，logo 同样要换

// 系统深浅色变化（主题选「跟随系统」时）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  renderTabs();
  if (!overlay.hidden) renderServiceList();
});
```

**Vue 版原先的问题**：`SettingsPanel.vue` 的 `setTheme()` 只做了 `appStore.apply({ theme: ... })`，**没有触发任何 logo 重渲染**；且全工程**没有任何 `matchMedia('(prefers-color-scheme)')` 监听**。

**为什么会失效**：图标变体由 `builtinIcon()` → `iconPathFor()` → `prefersDark()` 决定，而 `prefersDark()` 原本是**非响应式的纯函数**（直接读 `matchMedia(...).matches`）。Vue 组件里 `iconSrc` 的响应式依赖只有 `props.svc` / `appStore.services`，**不依赖 `prefersDark()` 的结果**。主题切换只改了 `appStore.theme`（一个没被 `iconSrc` 读到的字段），所以 logo 变体不会重算，会卡在旧主题的图。

**影响**：深色↔浅色切换后，内置站点 logo（尤其黑白单色 logo）颜色不对，直到下次触发 services 变更才恢复。

**已采用的修法**（`utils/env.ts`）：把「当前是否深色」做成响应式——用 `ref` 接住 `matchMedia('(prefers-color-scheme: dark)')` 的 `change` 事件，`prefersDark()` 返回该 `ref` 的值。这样 `ServiceRow` 的 `computed(() => builtinIcon(svc))`、`TabBar` 渲染期调用的 `iconSrc()`、`AddPanel` 的 `iconPathFor()` 都会自动重算，等价于原版那两个 `renderTabs()` / `renderServiceList()`，但不需要手写重画。

### 2.2 【需真机验证·中】`statusStore.statusOf` 的「边读边写」模式

**原生**：`status` 是普通 `Map`，`statusOf(id)` 里 `if (!status.has(id)) status.set(id, 默认值)` 是纯数据操作，无副作用。

**Vue 版**：`status` 是 `reactive(new Map())`，`statusOf` 里同样的「读 has → 写 set」模式，会在**渲染期间**触发响应式写操作。如果某个组件在 `render` 阶段首次调用 `statusOf(某新id)`，就会在渲染过程中修改 reactive 状态，Vue 可能告警「在渲染期间修改状态」，甚至触发一次额外重渲染。

**现状评估**：`TabBar.vue` 里 `statusOf` 是普通函数（非 computed），模板里 `showSpin(svc)` / `hasError(svc)` 等会在渲染期调用 `statusOf`。首次渲染时若某个 id 尚未在 Map 里，就会触发边读边写。**通常能工作**（Vue 对这种情况有容错，只是可能告警 + 多一次渲染），但属于「原生不会有的隐性代价」。

**建议**：把 `statusOf` 的「缺失时补默认值」改成「读不到就返回一个不落库的默认对象」，或确保 `applyPatch` 前一定先 `set` 默认值（订阅初始化时预填）。

### 2.3 【待验证·低】`useTabDrag` / `useDividerDrag` 的模块级单例状态

**原生**：`geometry`、`drag`、`tabDrag`、`hotZone` 都是脚本顶层 `let`，天然单例，生命周期 = 页面生命周期。

**Vue 版**：`useTabDrag.ts` / `useDividerDrag.ts` 里 `let tabDrag`、`let drag` 等也是**模块级** `let`（不是 `ref`），只有 `dragActive`/`dropTargets` 等需要进模板的才用 `ref`。这套「模块级可变状态 + 少量 ref 桥接」的模式，在**单实例 SPA**里是成立的（组件卸载不会清掉模块状态，符合拖拽全局手势的语义）。

**风险点**：如果将来做 HMR 或多次 `createApp`（测试里），模块级 `let` 会跨实例残留。当前单实例场景无碍，但这是「vanilla 习惯带进框架」的典型痕迹，值得在代码评审里标记。

### 2.4 【待验证·低】主题/休眠滑块的「首次定位不播动画」靠 `nextTick` 而非强制回流

**原生**（`renderTheme`/`renderNap`）：首次定位用 `instant` 类 + `void thumb.offsetWidth` 强制回流 + `rAF` 关掉 instant，保证「面板打开时滑块瞬间到位、不滑一段」。

**Vue 版**：`SettingsPanel.vue` 里滑块用 `:style="{ transform: 'translateX(' + themeIndex * 100 + '%)' }"` 直接绑 computed，**没有 instant/强制回流的区分**。面板打开瞬间，如果 `themeIndex` 从 0 变到别的值，滑块**可能会播一段过渡动画**（视觉上从第 0 格滑到目标格），而不是瞬间到位。

**影响**：轻微视觉差异——打开设置面板的瞬间，主题/休眠滑块可能「滑」一下。非功能性缺陷。

**修复方向**：给滑块加一个「首次渲染禁用过渡」的标记，或参考原生用 instant 类 + rAF 关掉。

---

## 三、已确认「迁移到位、无需担心」的点

- ✅ `renderLayout` 里「多栏隐藏中央占位文字」（`stage.style.visibility`）→ `App.vue` 的 `watch(isMulti)` 已实现
- ✅ `geometry.top = 44` 硬编码 → `layout.ts` 的 `top: 44` 一致（Rust 端 `TAB_BAR_HEIGHT = 44` 也是硬编码，三方一致）
- ✅ `ServiceRow` 的「已收起」「内置」pill → 已保留（`v-if="svc.hidden"` / `v-if="!svc.custom"`）
- ✅ 标签拖拽、分隔条拖拽三个雷区 → 原样保留（见 02 审核文档 §4.1）

---

## 四、建议处理顺序

1. **【先真机验证】2.1**：切一次深/浅主题，确认配色和内置 logo 变体都跟着变。Rust 端推的是窗口主题，外壳 webview 的 `prefers-color-scheme` 是否随之更新需实测。
2. **【验证】2.2**：开 devtools 看首次渲染有没有「在渲染期间修改状态」告警。
3. **【验证】2.4**：打开设置面板，看主题/休眠滑块有没有「滑一下」。
4. **【参考】2.3**：代码评审时标记，单实例场景无需处理。

---

## 附：本轮真机联调已修复的完整清单（含上一份审核文档未覆盖的）

| 问题 | 文件 | 说明 |
|---|---|---|
| Pinia 顶层实例化导致挂载失败 | `composables/useTabDrag.ts` | 改延迟解析 |
| `window.api` 未赋值 | `api/index.ts` | 补 `window.api = api` |
| 34 处 `window.api.xxx` 混用 | 10 个文件 | 统一 `import { api }` |
| `window.api` 类型改可选 | `api/types.ts` | 编译期防回归 |
| 工具栏缺「首页」「分屏」按钮 | `components/Toolbar.vue` | 按原版补齐 |
| `home` 签名 `string`→`string\|null` | `api/types.ts` | 对齐 reload |

### 后续同步上游的修复

| 问题 | 文件 | 说明 |
|---|---|---|
| 主题切换后深浅配色不生效 | `src-tauri/src/commands.rs`、`lib.rs` | 从 `fix/theme-switch-not-applied` cherry-pick；改主题时推给窗口，启动时按配置建窗口 |
| 内置 logo 深浅变体不跟随主题 | `src-ui/src/utils/env.ts` | 把「当前是否深色」改为响应式，等价于原版的 `renderTabs()` 重画 |
| CSP 放行 HMR | `index.html` | `ws://localhost:1420` |
