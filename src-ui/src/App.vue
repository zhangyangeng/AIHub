<script setup lang="ts">
// 根组件：外壳窗口的整体骨架。
// 自上而下是 bar（标签栏 + 主机名 + 工具栏）、拖拽投放区、分隔条、stage、toast、设置面板、添加面板。
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useAppStore, useStatusStore } from '@/stores/app';
import { useLayoutStore } from '@/stores/layout';
import { useOverlayStore } from '@/stores/overlay';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { IS_MAC, prettyAccel } from '@/utils/env';
import TabBar from '@/components/TabBar.vue';
import Toolbar from '@/components/Toolbar.vue';
import DropZones from '@/components/DropZones.vue';
import SplitDividers from '@/components/SplitDividers.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';
import AddPanel from '@/components/AddPanel.vue';

const appStore = useAppStore();
const statusStore = useStatusStore();
const layoutStore = useLayoutStore();
const overlayStore = useOverlayStore();
const { visible, isError, sticky, message, actionLabel, dismiss } = useToast();

/** 中央提示文字（无服务/加载失败/加载中） */
const stageMsg = computed(() => {
  const svc = appStore.services.find((s) => s.id === appStore.activeId);
  if (!svc) return '还没有任何服务，点右上角 ⚙ 添加一个吧。';
  const st = statusStore.statusOf(svc.id);
  if (st.error) {
    return '「' + svc.name + '」加载失败：' + (st.error.desc || st.error.code) + '。按 F5 重试，或在设置里检查网址。';
  }
  if (st.loading) {
    return '正在打开「' + svc.name + '」…';
  }
  // 站点加载完成后的全局快捷键提示（只列真正实现了的键，别承诺不存在的）
  const acc = prettyAccel((appStore.hotkey && appStore.hotkey.accelerator) || 'Alt+Space');
  return '全局唤出：' + acc + ' · 点标签切换 · F5 刷新当前标签';
});

// 标签栏收起时，站点视图顶边从 44 变 0，外壳要同步撤掉顶栏
watch(
  () => appStore.tabBarVisible,
  (visibleVal) => {
    document.body.classList.toggle('no-tabbar', visibleVal === false);
  },
  { immediate: true },
);

// 多栏时隐藏中央占位文字，避免从缝隙里露出来
watch(
  () => layoutStore.isMulti,
  (multi) => {
    const stage = document.getElementById('stage');
    if (stage) stage.style.visibility = multi ? 'hidden' : '';
  },
  { immediate: true },
);

// ---- 全局键盘：F5 / Ctrl+R 刷新、Esc 关闭面板 ----
function onKeydown(event: KeyboardEvent) {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;

  // F5 / Ctrl+R 刷新当前标签，按住 Shift 硬刷新（只在焦点位于外壳时生效）
  const wantsReload = event.key === 'F5' || (mod && (event.key === 'r' || event.key === 'R'));
  if (wantsReload && !event.repeat) {
    event.preventDefault();
    if (event.shiftKey) api.reloadHard(null);
    else api.reload(null);
    return;
  }

  // Esc：先关添加面板，再关设置面板
  if (event.key === 'Escape') {
    if (overlayStore.addPanelOpen) {
      overlayStore.setAddPanel(false);
      return;
    }
    if (overlayStore.settingsOpen) {
      overlayStore.setSettings(false);
    }
    return;
  }

  // Ctrl+, / ⌘, 打开设置。
  //
  // 这条只是兜底：站点视图是叠在外壳上的独立 webview，键盘焦点在站点那边时
  // 这里根本收不到 keydown。真正生效的是 Rust 端在窗口有焦点期间注册的同名
  // 系统级快捷键（lib.rs 的 sync_settings_shortcut），它通过 ui:open-settings
  // 事件回来。两者不会重复触发——系统级快捷键会把按键吃掉。
  if (mod && (event.key === ',' || event.code === 'Comma') && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    overlayStore.setSettings(true);
  }
}

// ---- 页面空白处右键 ----
function onContextMenu(event: MouseEvent) {
  const el = event.target as HTMLElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  event.preventDefault();
  api.openShellMenu({ x: Math.round(event.clientX), y: Math.round(event.clientY) });
}

let unlistenOpenSettings: (() => void) | null = null;

onMounted(async () => {
  appStore.subscribe();
  statusStore.subscribe();
  layoutStore.subscribe();

  // 主进程要求打开设置（托盘/菜单栏触发）
  unlistenOpenSettings = api.onOpenSettings(() => overlayStore.setSettings(true));

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('contextmenu', onContextMenu);

  try {
    const initial = await api.getState();
    appStore.apply(initial);
    // 首屏 layout 事件可能在页面加载完成前就发过了，主动补拉一次几何
    await layoutStore.refresh();
  } catch (err) {
    console.error('[aihub] getState 失败:', err);
  }
});

onUnmounted(() => {
  if (unlistenOpenSettings) unlistenOpenSettings();
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('contextmenu', onContextMenu);
});
</script>

<template>
  <div class="shell-root">
    <div id="bar">
      <TabBar />
      <div class="spacer"></div>
      <Toolbar />
    </div>

    <!-- 拖标签到页面区域时浮出来的投放区 -->
    <DropZones />

    <!-- 添加 AI 面板 -->
    <AddPanel />

    <div id="stage">
      <img class="brand-mark" src="/build/icon.png" alt="" width="72" height="72" />
      <h1>Aihub</h1>
      <p id="stage-msg">{{ stageMsg }}</p>
    </div>

    <!-- 分屏分隔条 -->
    <SplitDividers />

    <!-- 设置面板 -->
    <SettingsPanel />

    <!-- Toast -->
    <div id="toast" role="status" aria-live="polite" :class="{ show: visible, err: isError, sticky }">
      <span id="toast-text">{{ message }}</span>
      <button v-if="actionLabel" id="toast-action" type="button" @click="dismiss">
        {{ actionLabel }}
      </button>
    </div>
  </div>
</template>
