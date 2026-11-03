# 前端重构审核报告

> 审核时间：2026-10-31
> 审核范围：原生 `src-ui/index.html`（2893 行）→ Vue 3 工程（`src-ui/src/`）的逐函数对照
> 审核结论：**核心功能完整迁移，功能遗漏已修复（stage 快捷键提示文案），2 个需真机验证的行为差异、若干原生遗留问题（含 1 段死代码）。**

---

## 一、总体结论

| 维度 | 结论 |
|---|---|
| IPC 契约（api-shim.js → api/index.ts） | ✅ 完整，方法名/参数/返回值一致 |
| 标签栏（TabBar） | ✅ 完整 |
| 拖拽分屏 + 分隔条（useTabDrag/useDividerDrag/DropZones/SplitDividers） | ✅ 完整，三个雷区原样保留 |
| 设置面板 + 服务管理（SettingsPanel/ServiceRow） | ✅ 完整 |
| 添加面板（AddPanel） | ✅ 完整 |
| 快捷键录制（HotkeySection） | ✅ 完整 |
| 账号迁移（MigrateSection） | ✅ 完整 |
| 更新检查/强制更新（SettingsPanel 内） | ✅ 基本完整，但有 1 处遗漏（见 2.1） |
| 全局键盘/右键菜单（App.vue） | ✅ 完整 |

---

## 二、发现的功能遗漏（已补）

### 2.1 【已确认：非遗漏，是原生死代码】`maybeNotifyUpdate` 在原版就是无效的

**深入核对后的结论**：原生的 `maybeNotifyUpdate(next.update)` 是**死代码**，Vue 版没有迁移它**不算遗漏**。

**证据链**：
1. 原生 `applyState` 调用 `maybeNotifyUpdate(next.update)`，判断 `update.status === 'ready'`；
2. 但 Rust 端 `state_payload()` 返回的 state **根本没有 `update` 字段**（只有 services/activeId/panes/weights/preload/hibernate/theme/hotkey/alwaysOnTop/tabBarVisible/version/platform）；
3. Rust 端 `UpdateInfo` 结构体也只有 `available/current/version/notes/error`，**没有 `status` 字段**；
4. Rust 端**没有「后台自动下载」机制**——只有手动 `update_check` / `update_install`，`update:progress` 事件只在用户点「强制更新」时发出。

**结论**：`next.update` 永远是 `undefined`，`maybeNotifyUpdate` 的 `update.status === 'ready'` 分支永远不会触发。这是原生代码里一段「写了但从未生效」的死代码（很可能是 Electron 版遗留的、迁移到 Tauri 后后端没实现对应字段）。

**处理建议**：**无需迁移**。Vue 版删掉这段死代码是合理的。但 `types.ts` 里的 `AppState.update?: UpdateInfo` 字段可以保留（无害），也可以删掉。**若未来要做「后台自动下载 + 就绪提示」，需要先在 Rust 端实现，这是新增功能，超出本次迁移范围。**

### 2.2 【已修复】stage 中央提示文字的「快捷键提示」分支缺失

**原生行为**：`renderTools()` 里，当站点**加载完成**（无 error、非 loading）时，`stageMsg` 显示完整提示：

```
全局唤出：Alt+Space · Ctrl+Tab 切换标签 · Ctrl+1~9 直达 · F5 刷新 · Ctrl+, 设置
```

**原 Vue 版现状**：`App.vue` 的 `stageMsg` 计算属性，在「无 error、非 loading」分支返回**空字符串**。

**影响**：这段文字正常情况下被站点 webview 盖住看不到，但**在站点加载失败前 / 首次启动的瞬间**会露出来。原版有引导性文案，Vue 版是空白。属于轻微体验退化，非致命。

**修复**：`App.vue` 的 `stageMsg` else 分支已补上原生的快捷键提示文案，`prettyAccel` 与 `IS_MAC` 从 `utils/env.ts` 导入，与原版 `renderTools()` 逐字一致（mac 显示 `⌘`/`⌃Tab`，其它平台显示 `Ctrl+`）。构建（vue-tsc + vite）已通过。

---

## 三、需真机验证的行为差异（非缺陷，但需确认）

### 3.1 【待验证】双击分隔条「均分」是否实际生效

**发现链路**：
1. 前端双击分隔条 → `api.endDrag({ index, equalize: true })`
2. Rust 端 `layout_drag_end(app: AppHandle)` —— **不接收任何参数**，函数体是 `mutate(&app, |_cfg| {})` 空操作
3. Rust 端另有 `layout_equalize(app)`（全量均分）和 `layout.rs` 里的 `equalize_divider(weights, index)`（单分隔条均分），但**双击的 `equalize: true` 参数既没走到 `equalize_divider`，也没触发 `layout_equalize`**

**结论**：**这是原生代码本身就存在的疑点**——双击传了 `equalize: true`，但 Rust 端 `layout_drag_end` 直接忽略。双击均分**很可能在原版里就是无效的**（双击只是触发了一次 `layout_drag_end` 空操作 + 可能触发了别处的均分？）。

Vue 版忠实保留了原行为（传 `equalize: true`），所以**没有引入新偏差，但也没修复这个疑点**。

**待验证**：真机跑起来后，双击分隔条，看两栏宽度是否真的均分。
- 如果均分生效 → 说明 `layout_drag_end` 的空操作里 `mutate` 触发了别的均分逻辑，或前端另有路径；
- 如果不生效 → 这是原生遗留 bug，可选择性修复（前端改调 `layout_equalize` 或后端 `layout_drag_end` 接收 index 调 `equalize_divider`）。

### 3.2 【待验证】`endDrag` 参数的传递差异（已确认无影响）

- 原生 api-shim.js：`endDrag: () => send('layout_drag_end')` —— **忽略了调用方传的 index/equalize**
- Vue 版 api/index.ts：`endDrag: (extra) => send('layout_drag_end', extra || {})` —— **补上了参数**

**结论**：因为 Rust 端 `layout_drag_end` 根本不接收参数（见 3.1），所以**两者行为完全等价**。Vue 版的写法更「忠实于调用方意图」，但实际效果和原生一样（参数被 Rust 忽略）。**不是缺陷，无需处理**，但记录在案以免后续困惑。

---

## 四、已确认正确保留的关键点（无需改动）

### 4.1 三个雷区全部原样保留 ✅
1. **分隔条节流用 `setTimeout` 非 rAF**（`useDividerDrag.ts` 第 3-4 行注释 + 时间戳节流实现）
2. **标签拖拽用鼠标事件非 HTML5 拖放**（`useTabDrag.ts` 第 4-6 行注释）
3. **`slotRects()` 田字格算法与 Rust `compute_grid` 一致**（1/2/3/4 格的几何公式逐行一致）

### 4.2 IPC 契约的 asResult 语义 ✅
`exportLogin` / `importLogin` 保留了 `asResult` 包装（失败返回 `{ok:false,error}` 而非 reject），这是登录迁移按钮「永久变灰」bug 的修复关键，已正确迁移。

### 4.3 视图让位仲裁（syncViewYield）✅
三个独立开关（设置面板 / 添加面板 / 拖拽）求或、只在结果变化时发 IPC，逻辑完整迁移到 `overlay.ts`。

### 4.4 `challenge-guard.js` 编译期依赖 ✅
Rust `include_str!("../../src-ui/challenge-guard.js")` 硬依赖，文件保留在 `src-ui/` 根，路径未动，`cargo check` 已验证编译通过。

---

## 五、原生代码遗留问题（重构时未引入，但顺带发现）

这些是**原生代码本身就存在的**问题，重构时选择了「忠实保留」而非「顺手修复」，列出来供你决策：

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| 1 | 双击分隔条均分疑似无效（`equalize:true` 被 Rust 忽略） | 见 3.1 | 真机验证后决定是否修复 |
| 2 | `api-shim.js` 的 `endDrag` 定义漏传参数（调用方传了但定义里丢了） | 原生 api-shim.js | Vue 版已补，无需处理 |
| 3 | Ctrl+Tab 切换标签、Ctrl+1~9 直达：只在提示文字里提到，前端从未实现 | 原生 renderTools 的文案 | 确认是否在 Rust 端（global-shortcut）实现；若没有，属于「文案承诺了但没做」 |

---

## 六、审核过程中已确认「行为一致」的细节

- ✅ `syncTab` 的 title 拼接（分屏栏位 / 焦点 / 休眠标记）→ TabBar.vue `tabTitle()`
- ✅ 标签图标解析（内置 logo 优先 → favicon → 圆点）→ TabBar.vue `iconSrc()` + `utils/icons.ts`
- ✅ 标签 × 收起 + 「撤销」toast → TabBar.vue `onClose()`
- ✅ 中键重载（auxclick button===1）→ TabBar.vue `onAuxClick()`
- ✅ 标签右键 = 加入/移出分屏 → TabBar.vue `onContextMenu()`
- ✅ 分隔条几何（hitX/hitWidth 热区）→ `useDividerDrag.dividerStyle()`
- ✅ 拖拽阈值 4px、Esc 取消、20 秒兜底 → `useTabDrag` 各常量
- ✅ 拖拽后 click 拦截（300ms）→ `useTabDrag.installTabDragGlobals()`
- ✅ 主题/休眠滑块的 `translateX(index * 100%)` 响应式定位 → SettingsPanel.vue
- ✅ 快捷键录制（focus/blur/mousedown/keydown、Esc 取消、修饰键校验）→ HotkeySection.vue
- ✅ 账号迁移的 dryRun 预检 + needsPassword 重试 → MigrateSection.vue

---

## 七、建议的处理顺序

1. **【已完成】补 2.2**：stage 的快捷键提示文案已补上（见 2.2）。
2. **【验证】3.1**：真机双击分隔条，确认均分是否生效，决定是否修原生遗留 bug。
3. **【可选】五.3**：确认 Ctrl+Tab / Ctrl+1~9 是否在 Rust 端实现，若没有可考虑补（但这属于「新增功能」，超出本次「全功能迁移」范围）。
4. **【参考】2.1**：已确认 `maybeNotifyUpdate` 是原生死代码，无需处理；若未来要做「后台自动下载 + 就绪提示」，需先在 Rust 端实现。

---

## 附：文件对照清单

| 原生函数/模块 | Vue 版对应文件 | 状态 |
|---|---|---|
| api-shim.js | api/index.ts + types.ts | ✅ |
| toast / toastAction | composables/useToast.ts | ✅ |
| syncViewYield | stores/overlay.ts | ✅ |
| state + status Map + applyState | stores/app.ts | ✅（原 maybeNotifyUpdate 为死代码，无需迁移） |
| geometry + renderLayout | stores/layout.ts | ✅ |
| tabNodeFor / syncTab / renderTabs | components/TabBar.vue | ✅ |
| renderTools / renderAll | components/Toolbar.vue + App.vue | ✅ 快捷键提示分支已补 |
| startTabDrag ~ applyDrop / slotRects | composables/useTabDrag.ts | ✅ |
| buildDropZones / dragGhost | components/DropZones.vue | ✅ |
| onDividerDown/Move/Up/DoubleClick | composables/useDividerDrag.ts + SplitDividers.vue | ✅ |
| setOverlay / serviceRow / renderServiceList | SettingsPanel.vue + ServiceRow.vue | ✅ |
| openAddPanel / closeAddPanel | AddPanel.vue | ✅ |
| renderHotkey / 录制 | HotkeySection.vue | ✅ |
| 登录迁移（doImport/exportLogin） | MigrateSection.vue | ✅ |
| wireUpdate | SettingsPanel.vue（更新区块） | ✅（原 maybeNotifyUpdate 死代码，已忽略） |
| svg / ICON_TABLE / builtinIcon | utils/icons.ts | ✅ |
| hostOf / escapeHtml / prettyAccel / 快捷键 | utils/env.ts | ✅ |
| 初始化订阅（onState/onLayout/onTabStatus/getState） | App.vue + main.ts | ✅ |
| contextmenu / F5 / Esc | App.vue | ✅ |
