// 分屏几何状态 store：对应原 index.html 的 `geometry` 全局变量 + renderLayout()。
// 由 Rust 端通过 layout:changed 事件推送，初始化时主动 getLayout() 拉一次。

import { defineStore } from 'pinia';
import { api } from '@/api';
import type { LayoutGeometry } from '@/api/types';

export const useLayoutStore = defineStore('layout', {
  state: (): LayoutGeometry => ({
    panes: [],
    dividers: [],
    gap: 4,
    minPaneWidth: 260,
    top: 44,
    overlay: false,
  }),

  getters: {
    /** 是否多栏（决定中央占位文字要不要隐藏、分隔条要不要显示） */
    isMulti(state): boolean {
      return state.panes.length > 1;
    },
    /** 分隔条是否可见（被遮罩盖住、或没有分隔条时隐藏） */
    dividersVisible(state): boolean {
      return !state.overlay && state.dividers.length > 0;
    },
  },

  actions: {
    /** 应用一份新的布局几何（对应原 renderLayout） */
    apply(next: LayoutGeometry | null | undefined) {
      if (!next) return;
      Object.assign(this, next);
    },

    /** 订阅 Rust 端的布局推送（在 main.ts 初始化时调用一次） */
    subscribe() {
      api.onLayout((next) => this.apply(next));
    },

    /** 首屏主动拉一次几何（layout 事件可能在页面加载前就发过了） */
    async refresh() {
      this.apply(await api.getLayout());
    },
  },
});
