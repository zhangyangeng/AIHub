<script setup lang="ts">
// 工具栏 + 主机名 + 中央提示文字，对应原 index.html 的 renderTools / renderAll。
import { computed } from 'vue';
import { useAppStore, useStatusStore } from '@/stores/app';
import { useOverlayStore } from '@/stores/overlay';
import { hostOf } from '@/utils/env';

const appStore = useAppStore();
const statusStore = useStatusStore();
const overlayStore = useOverlayStore();

const active = computed(() => appStore.services.find((s) => s.id === appStore.activeId));

const host = computed(() => {
  const svc = active.value;
  if (!svc) return '';
  const st = statusStore.statusOf(svc.id);
  return st.url ? hostOf(st.url) : '';
});

function reload() {
  window.api.reload(null);
}

function openAdd() {
  overlayStore.setAddPanel(true);
}

function openSettings() {
  overlayStore.setSettings(true);
}
</script>

<template>
  <div id="host">{{ host }}</div>
  <div id="tools">
    <button class="icon-btn" id="btn-reload" title="重新加载当前标签（F5 / Ctrl+R，加 Shift 强制刷新）" @click="reload">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
    <button class="icon-btn" id="btn-add" title="添加 AI 到标签栏" @click="openAdd">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    <button class="icon-btn" id="btn-settings" title="设置（Ctrl+,）" @click="openSettings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    </button>
  </div>
</template>

<script lang="ts">
export default { name: 'Toolbar' };
</script>
