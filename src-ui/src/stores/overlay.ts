// 视图让位仲裁 store：决定站点视图什么时候给外壳让开。
//
// 站点视图是原生层，盖在外壳页面之上。设置面板、添加面板、拖拽分屏都需要它「让开」，
// 但它们是三个独立的开关——谁都不能直接发 IPC，不然后调的会覆盖先调的，
// 出现「设置面板还开着，视图却被放回来盖住它」这种事。
//
// 统一在这里按「有任何一方要求让位」来算，只在结果真的变了时才发 IPC。

import { defineStore } from 'pinia';
import { api } from '@/api';

export const useOverlayStore = defineStore('overlay', {
  state: () => ({
    /** 设置面板开着 */
    settingsOpen: false,
    /** 添加 AI 面板开着 */
    addPanelOpen: false,
    /** 「添加自定义网站」对话框开着（挂在设置面板的站点页上） */
    customAddOpen: false,
    /** 拖拽中，站点视图临时让开 */
    dragYielding: false,
    /** 当前是否已让位（缓存，避免重复发 IPC） */
    viewsYielded: false,
  }),

  actions: {
    /** 按「任何一方要求让位」重新计算，只在结果变化时才发 IPC */
    syncViewYield() {
      const want = this.settingsOpen || this.addPanelOpen || this.dragYielding;
      if (want === this.viewsYielded) return;
      this.viewsYielded = want;
      api.setOverlay(want);
    },

    /** 打开/关闭设置面板 */
    setSettings(open: boolean) {
      this.settingsOpen = open;
      // 面板关掉时对话框也跟着收，否则下次打开会顶着一个上次没填完的表单
      if (!open) this.customAddOpen = false;
      this.syncViewYield();
    },

    /** 打开/关闭添加面板 */
    setAddPanel(open: boolean) {
      this.addPanelOpen = open;
      this.syncViewYield();
    },

    /** 从添加面板切到「自定义网站」：关弹窗、开设置、弹出表单 */
    requestCustomAdd() {
      this.addPanelOpen = false;
      this.settingsOpen = true;
      this.customAddOpen = true;
      this.syncViewYield();
    },

    setCustomAdd(open: boolean) {
      this.customAddOpen = open;
    },

    /** 拖拽开始/结束 */
    setDragYielding(yielding: boolean) {
      this.dragYielding = yielding;
      this.syncViewYield();
    },
  },
});
