<script setup lang="ts">
// 根组件：外壳布局骨架。
// 对应原 index.html 的 <body> 结构：bar（tabs + host + tools）、stage、toast。
// 设置面板、添加面板、分屏投放区等在后续阶段逐步接入。
import { computed, onMounted } from 'vue';
import { useAppStore, useStatusStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import TabBar from '@/components/TabBar.vue';
import Toolbar from '@/components/Toolbar.vue';

const appStore = useAppStore();
const statusStore = useStatusStore();
const { visible, isError, sticky, message, actionLabel, dismiss } = useToast();

/** 中央提示文字（无服务/加载失败/加载中/快捷键提示） */
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
  return '';
});

onMounted(async () => {
  appStore.subscribe();
  statusStore.subscribe();
  try {
    const initial = await window.api.getState();
    appStore.apply(initial);
  } catch (err) {
    console.error('[aihub] getState 失败:', err);
  }
});
</script>

<template>
  <div class="shell-root">
    <div id="bar">
      <TabBar />
      <div class="spacer"></div>
      <Toolbar />
    </div>

    <!-- 分屏投放区（P3 接入） -->
    <div id="dropzones" aria-hidden="true"></div>

    <!-- 添加 AI 面板（P4 接入） -->
    <!-- 设置面板（P4 接入） -->

    <div id="stage">
      <img class="brand-mark" src="/build/icon.png" alt="" width="72" height="72" />
      <h1>Aihub</h1>
      <p id="stage-msg">{{ stageMsg }}</p>
    </div>

    <div id="split-layer" hidden></div>

    <!-- Toast -->
    <div id="toast" role="status" aria-live="polite" :class="{ show: visible, err: isError, sticky }">
      <span id="toast-text">{{ message }}</span>
      <button v-if="actionLabel" id="toast-action" type="button" @click="dismiss">
        {{ actionLabel }}
      </button>
    </div>
  </div>
</template>
