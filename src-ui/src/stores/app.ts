// 主状态 store：服务列表、当前激活项、布局偏好，以及每个标签的运行时状态。
// 由 Rust 端通过 state:changed / tab:status 事件推送更新。

import { defineStore } from 'pinia';
import { reactive } from 'vue';
import type { AppState, Service, TabStatus } from '@/api/types';
import { api } from '@/api';

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    services: [],
    activeId: null,
    panes: [],
    weights: [],
    maxPanes: 4,
    preload: true,
    theme: 'system',
    hotkey: {},
    version: '',
    alwaysOnTop: true,
    tabBarVisible: true,
  }),

  getters: {
    /** 顶栏上可见的服务（收起的不显示） */
    shownServices(state): Service[] {
      return state.services.filter((s) => !s.hidden);
    },
    /** 当前激活的服务 */
    activeService(state): Service | undefined {
      return state.services.find((s) => s.id === state.activeId);
    },
  },

  actions: {
    /** 应用一份新的全局状态 */
    apply(next: AppState | null | undefined) {
      if (!next) return;
      Object.assign(this, next);
    },

    /** 激活某个服务标签 */
    activate(id: string) {
      api.activate(id);
    },

    /** 把某个服务加入/移出分屏 */
    async togglePane(id: string) {
      const inLayout = this.panes.includes(id);
      const next = inLayout ? this.panes.filter((p) => p !== id) : this.panes.concat(id);
      const res = await api.setPanes(next);
      if (res && res.ok === false) return { ok: false, error: res.error };
      if (res && res.state) this.apply(res.state);
      return { ok: true };
    },

    /** 订阅 Rust 端的状态推送（在 main.ts 初始化时调用一次） */
    subscribe() {
      api.onState((next) => this.apply(next));
    },
  },
});

/**
 * 标签运行时状态 store：每个服务的标题、favicon、加载中、错误、休眠。
 * 用 reactive Map 保持「就地更新」的语义——状态消息来得很频繁，
 * 整表重建会触发多余的重渲染。
 */
export const useStatusStore = defineStore('status', () => {
  const status = reactive(new Map<string, TabStatus>());

  function statusOf(id: string): TabStatus {
    if (!status.has(id)) {
      status.set(id, { id, loading: false, error: null, favicon: '', url: '', title: '', hibernated: false });
    }
    return status.get(id)!;
  }

  /** 应用一个 tab:status 补丁 */
  function applyPatch(patch: TabStatus | null | undefined) {
    if (!patch || !patch.id) return;
    const st = statusOf(patch.id);
    Object.assign(st, patch);
  }

  function subscribe() {
    api.onTabStatus((patch) => applyPatch(patch));
  }

  return { status, statusOf, applyPatch, subscribe };
});
