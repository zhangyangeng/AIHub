// 前端与 Rust 后端的接口边界：与 src-tauri/src/commands.rs 的 #[tauri::command] 一一对应。
// 方法名或参数形状改动时，两边必须同时改。

/** 一个 AI 服务的配置 */
export interface Service {
  id: string;
  name: string;
  url: string;
  icon?: string;
  color?: string;
  custom?: boolean;
  hidden?: boolean;
  active?: boolean;
}

/** 单个标签的运行时状态（由 tab:status 事件推送） */
export interface TabStatus {
  id: string;
  loading?: boolean;
  error?: { code?: string; desc?: string } | null;
  favicon?: string;
  url?: string;
  title?: string;
  hibernated?: boolean;
}

/** 休眠设置 */
export interface HibernateConfig {
  enabled?: boolean;
  minutes?: number;
}

/** 全局快捷键配置 */
export interface HotkeyConfig {
  enabled?: boolean;
  accelerator?: string;
  pinTop?: boolean;
  tray?: boolean;
  closeToTray?: boolean;
  registered?: boolean;
  error?: string;
  presets?: { label?: string; accelerator: string; note?: string }[];
  defaultAccelerator?: string;
}

/** 更新信息 */
export interface UpdateInfo {
  status?: string;
  version?: string;
  available?: boolean;
  current?: string;
  notes?: string;
  error?: string;
}

/** 应用全局状态（getState / state:changed 返回的形状） */
export interface AppState {
  services: Service[];
  activeId: string | null;
  panes: string[];
  weights: number[];
  maxPanes: number;
  preload: boolean;
  theme: string;
  hotkey: HotkeyConfig;
  version: string;
  alwaysOnTop?: boolean;
  tabBarVisible?: boolean;
  hibernate?: HibernateConfig;
  userData?: string;
  update?: UpdateInfo;
}

/** 分屏布局几何（layout:changed 事件推送） */
export interface LayoutGeometry {
  panes: string[];
  dividers: { index: number; x: number; width: number; hitX?: number; hitWidth?: number }[];
  gap: number;
  minPaneWidth: number;
  top: number;
  overlay: boolean;
}

/** 分屏投放点（田字格 slotRects 的返回值） */
export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 登录导出结果 */
export interface LoginExportResult {
  ok: boolean;
  file?: string;
  services?: number;
  cookies?: number;
  storages?: number;
  bytes?: number;
  skipped?: number;
  encrypted?: boolean;
  canceled?: boolean;
  error?: string;
}

/** 登录导入结果 */
export interface LoginImportResult {
  ok: boolean;
  file?: string;
  services?: { name: string; cookies: number; storages: number; failed?: number }[];
  unmatched?: { name: string }[];
  exportedAt?: string;
  encrypted?: boolean;
  needsPassword?: boolean;
  canceled?: boolean;
  error?: string;
}

/** 更新进度事件 */
export interface UpdateProgress {
  phase: 'downloading' | 'closing';
}

/** 启动自动检查发现的新版本（update:available 事件载荷） */
export interface UpdateAvailable {
  version?: string;
  notes?: string;
}

/** 右键菜单点位 */
export interface MenuPoint {
  x?: number;
  y?: number;
}

/**
 * 前端可用的全部后端接口。
 */
export interface AihubApi {
  // ---- 状态 ----
  getState: () => Promise<AppState>;
  onState: (handler: (state: AppState) => void) => () => void;
  onTabStatus: (handler: (patch: TabStatus) => void) => () => void;
  onOpenSettings: (handler: () => void) => () => void;
  onLayout: (handler: (layout: LayoutGeometry) => void) => () => void;

  // ---- 标签 ----
  activate: (id: string) => void;
  reload: (id: string | null) => void;
  reloadHard: (id: string | null) => void;
  home: (id: string | null) => void;
  devtools: (id: string) => void;
  zoom: (delta: number, id?: string) => void;

  // ---- 分屏布局 ----
  getLayout: () => Promise<LayoutGeometry>;
  setPanes: (ids: string[]) => Promise<{ ok: boolean; error?: string; state?: AppState }>;
  showSingle: (id: string) => void;
  equalize: () => void;
  focusPane: (id: string) => void;
  dragDivider: (index: number, x: number) => void;
  endDrag: (extra?: { index?: number; equalize?: boolean }) => void;

  // ---- 服务管理 ----
  addService: (input: { name: string; url: string }) => Promise<{ ok: boolean; error?: string; id?: string }>;
  updateService: (input: { id: string; name: string; url: string }) => Promise<{ ok: boolean; error?: string }>;
  removeService: (id: string, wipe: boolean) => Promise<{ ok: boolean; error?: string; state?: AppState }>;
  setServiceHidden: (id: string, hidden: boolean) => Promise<{ ok: boolean; error?: string }>;
  reorderServices: (ids: string[]) => Promise<{ ok: boolean; error?: string }>;
  availableServices: () => Promise<{ id: string; name: string; icon?: string }[]>;
  addBuiltin: (id: string) => Promise<{ ok: boolean; error?: string }>;

  // ---- 偏好 ----
  setPreload: (on: boolean) => Promise<{ ok: boolean; error?: string; preload?: boolean }>;
  getPreload: () => Promise<boolean>;
  setHibernate: (input: HibernateConfig) => Promise<{ ok: boolean; error?: string; hibernate?: HibernateConfig }>;
  setTheme: (theme: string) => Promise<{ ok: boolean; error?: string; theme?: string }>;
  setHotkey: (input: Partial<HotkeyConfig>) => Promise<{ ok: boolean; error?: string; hotkey?: HotkeyConfig; registered?: boolean }>;
  getHotkey: () => Promise<HotkeyConfig>;

  // ---- 窗口 ----
  summonWindow: () => void;
  hideWindow: () => void;
  setOverlay: (open: boolean) => void;
  openExternal: (url: string) => void;
  quit: () => void;

  // ---- 右键菜单 ----
  openSplitMenu: (point: MenuPoint) => Promise<unknown>;
  openShellMenu: (point: MenuPoint) => Promise<unknown>;

  // ---- 登录迁移 ----
  exportLogin: (password: string) => Promise<LoginExportResult>;
  importLogin: (options: { file?: string; password?: string; dryRun?: boolean }) => Promise<LoginImportResult>;

  // ---- 更新 ----
  checkUpdate: () => Promise<UpdateInfo>;
  installUpdate: () => Promise<unknown>;

  // ---- v4 新增 ----
  setAlwaysOnTop: (on: boolean) => Promise<{ ok: boolean; error?: string; alwaysOnTop?: boolean }>;
  setTabBar: (visible: boolean) => Promise<{ ok: boolean; error?: string; tabBarVisible?: boolean }>;
  placePane: (id: string, index: number) => Promise<{ ok: boolean; error?: string }>;
  swapPanes: (a: number, b: number) => Promise<{ ok: boolean; error?: string }>;
  removePane: (index: number) => Promise<{ ok: boolean; error?: string }>;
  getVersion: () => Promise<string>;
  onUpdateProgress: (handler: (progress: UpdateProgress) => void) => () => void;
  onUpdateAvailable: (handler: (info: UpdateAvailable) => void) => () => void;
}

/** 全局类型声明：window.api 和 window.AIHUB_ICONS */
declare global {
  interface Window {
    /**
     * 标记为可选：正常业务代码一律 `import { api } from '@/api'`，
     * 不要直接读 window.api。这里保留这个字段纯粹是调试用（devtools 里敲 api.xxx），
     * 标成可选是为了让谁再写 `window.api.xxx` 时，TS 会报「可能为 undefined」，
     * 在编译期就拦住，而不是等真机才炸。
     */
    api?: AihubApi;
    __TAURI__?: Record<string, any>;
    AIHUB_ICONS?: {
      files?: Record<string, string>;
      variants?: Record<string, { dark?: string; light?: string }>;
      hosts?: Record<string, string>;
      aliases?: Record<string, string>;
    };
  }
}

export {};
