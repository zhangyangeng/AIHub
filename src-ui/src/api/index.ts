// 前端到 Tauri 后端的 IPC 封装。
// 方法名、参数、返回值形状与 src-tauri/src/commands.rs 的 #[tauri::command] 一一对应。
// 依赖 tauri.conf.json 里的 withGlobalTauri: true，通过全局 window.__TAURI__ 调用。

import type { AihubApi } from './types';

type TauriCore = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
};

type TauriEvent = {
  listen: (event: string, handler: (e: { payload: any }) => void) => Promise<() => void>;
};

const T = window.__TAURI__ as unknown as { core?: TauriCore; event?: TauriEvent } | undefined;

const invoke = T?.core?.invoke ?? (() => Promise.reject(new Error('window.__TAURI__ 不存在')));
const listen = T?.event?.listen ?? (() => Promise.resolve(() => {}));

/**
 * 把 Tauri 的异步事件订阅包装成「同步返回退订函数」。
 * listen() 是异步的，调用方却期望立刻拿到一个可调用的退订函数，
 * 所以先返回占位闭包，等 listen 就绪后再补上。
 */
function on<T>(channel: string, handler: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  listen(channel, (event) => handler(event.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}

/** send 语义：不关心返回值，失败只记日志，绝不让 UI 卡住 */
function send(cmd: string, args?: Record<string, unknown>): void {
  invoke(cmd, args || {}).catch((err) => console.error(`[aihub] ${cmd} 失败:`, err));
}

/**
 * 把调用失败也变成返回值 { ok:false, error }，而不是让 Promise reject。
 *
 * 调用方一律按 `const res = await ...; if (!res.ok)` 处理，外面没有 try。
 * 而 Tauri 的 invoke 在 Rust 返回 Err 时是 reject——不包装的话，
 * 调用方会在 await 那一行中断，后面的错误提示都不会执行。
 */
function asResult<T>(promise: Promise<T>): Promise<T> {
  return promise.then(
    (value) => (value && typeof value === 'object' ? value : ({ ok: true, value } as unknown as T)),
    (err) => ({ ok: false, error: String((err && err.message) || err || '调用失败') } as unknown as T),
  );
}

/**
 * 业务代码统一通过 `import { api } from '@/api'` 使用，不要读 window.api。
 */
export const api: AihubApi = {
  // ---- 状态 ----
  getState: () => invoke('app_get_state'),
  onState: (handler) => on('state:changed', handler),
  onTabStatus: (handler) => on('tab:status', handler),
  onOpenSettings: (handler) => on('ui:open-settings', handler),
  onLayout: (handler) => on('layout:changed', handler),

  // ---- 标签 ----
  activate: (id) => send('tab_activate', { id }),
  reload: (id) => send('tab_reload', { id }),
  reloadHard: (id) => send('tab_reload_hard', { id }),
  home: (id) => send('tab_home', { id }),
  devtools: (id) => send('tab_devtools', { id }),
  zoom: (delta, id) => send('tab_zoom', { delta, id: id || null }),

  // ---- 分屏布局 ----
  getLayout: () => invoke('layout_get'),
  setPanes: (ids) => invoke('layout_set_panes', { ids }),
  showSingle: (id) => send('layout_single', { id }),
  equalize: () => send('layout_equalize'),
  focusPane: (id) => send('pane_focus', { id }),
  dragDivider: (index, x) => send('layout_drag', { index, x }),
  endDrag: (extra) => send('layout_drag_end', { index: extra?.index ?? 0, equalize: extra?.equalize ?? false }),

  // ---- 服务管理 ----
  addService: (input) => invoke('services_add', { input }),
  updateService: (input) => invoke('services_update', { input }),
  removeService: (id, wipe) => invoke('services_remove', { id, wipe: Boolean(wipe) }),
  setServiceHidden: (id, hidden) => invoke('services_set_hidden', { id, hidden: Boolean(hidden) }),
  reorderServices: (ids) => invoke('services_reorder', { ids }),
  availableServices: () => invoke('services_available'),
  addBuiltin: (id) => invoke('services_add_builtin', { id }),

  // ---- 偏好 ----
  setHibernate: (input) => invoke('config_set_hibernate', { input: input || {} }),
  setTheme: (theme) => invoke('config_set_theme', { theme: String(theme || '') }),
  setHotkey: (input) => invoke('config_set_hotkey', { input: input || {} }),
  getHotkey: () => invoke('config_get_hotkey'),

  // ---- 窗口 ----
  summonWindow: () => send('window_summon'),
  hideWindow: () => send('window_hide'),
  setOverlay: (open) => send('ui_overlay', { open: Boolean(open) }),
  openExternal: (url) => send('app_open_external', { url }),
  quit: () => send('app_quit'),

  // ---- 登录迁移（保留 asResult 语义：失败返回 {ok:false,error} 而非 reject）----
  exportLogin: (password) => asResult(invoke('login_export', { password: String(password || '') })),
  importLogin: (options) => asResult(invoke('login_import', { options: options || {} })),

  // ---- 更新 ----
  checkUpdate: () => invoke('update_check'),
  installUpdate: () => invoke('update_install'),
  onUpdateAvailable: (handler) => on('update:available', handler),

  // ---- v4 新增 ----
  setAlwaysOnTop: (on) => invoke('window_set_always_on_top', { on: Boolean(on) }),
  setTabBar: (visible) => invoke('window_set_tab_bar', { visible: Boolean(visible) }),
  setDevtools: (on) => invoke('config_set_devtools', { on: Boolean(on) }),
  placePane: (id, index) => invoke('layout_place', { id, index }),
  swapPanes: (a, b) => invoke('layout_swap', { a, b }),
  removePane: (index) => invoke('layout_remove_pane', { index }),
  getVersion: () => invoke('app_version'),
  onUpdateProgress: (handler) => on('update:progress', handler),
};

/**
 * 挂到全局，仅用于在 devtools 控制台调试（例如敲 api.getState() 看状态）。
 *
 * 业务代码不要读它：类型里 window.api 是可选的，直接访问会报「可能为 undefined」。
 */
window.api = api;
