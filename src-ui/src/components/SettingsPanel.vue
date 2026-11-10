<script setup lang="ts">
// 设置面板外壳：左栏分区导航 + 右栏单页内容。
//
// 分区的意义不在于「显得整齐」，而在于每一页都能一屏看完：
// 之前十来个区块平铺成一列，改个主题要滚过十几个服务行。
import { computed, ref, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { useOverlayStore } from '@/stores/overlay';
import SitesPage from '@/components/settings/pages/SitesPage.vue';
import GeneralPage from '@/components/settings/pages/GeneralPage.vue';
import HotkeyPage from '@/components/settings/pages/HotkeyPage.vue';
import PerfPage from '@/components/settings/pages/PerfPage.vue';
import DataPage from '@/components/settings/pages/DataPage.vue';
import AboutPage from '@/components/settings/pages/AboutPage.vue';

const appStore = useAppStore();
const overlayStore = useOverlayStore();

const open = computed(() => overlayStore.settingsOpen);
const visible = ref(false);
const closing = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 每次打开都从第一个分区（站点）开始 */
const section = ref('sites');

function close() {
  overlayStore.setSettings(false);
}

// ---- 面板开关过渡 ----
watch(open, (now) => {
  if (now) {
    if (closeTimer) clearTimeout(closeTimer);
    closing.value = false;
    visible.value = true;
    // 面板常驻挂载，组件实例不会销毁，分区会沿用上次点的值——每次打开都重置回第一个
    section.value = 'sites';
    return;
  }
  closing.value = true;
  if (closeTimer) clearTimeout(closeTimer);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  closeTimer = setTimeout(() => {
    visible.value = false;
    closing.value = false;
  }, reduced ? 190 : 150);
});

const version = computed(() => appStore.version || '0.1.0');
</script>

<template>
  <div v-if="visible" id="overlay" :class="{ open, closing }" @click.self="close">
    <section class="st-panel" role="dialog" aria-modal="true" aria-label="设置">
      <header class="st-bar">
        <span class="st-bar-title">设置</span>
        <button class="icon-btn" type="button" title="关闭（Esc）" aria-label="关闭" @click="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div class="st-body">
        <nav class="st-nav" aria-label="设置分区">
          <button class="st-nav-item" type="button" :aria-current="section === 'sites' ? 'page' : undefined" @click="section = 'sites'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18" />
            </svg>
            站点
          </button>
          <button class="st-nav-item" type="button" :aria-current="section === 'general' ? 'page' : undefined" @click="section = 'general'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
            </svg>
            通用
          </button>
          <button class="st-nav-item" type="button" :aria-current="section === 'hotkey' ? 'page' : undefined" @click="section = 'hotkey'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
            </svg>
            快捷键
          </button>
          <button class="st-nav-item" type="button" :aria-current="section === 'perf' ? 'page' : undefined" @click="section = 'perf'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 18V9M10 18V5M16 18v-6M22 18H2" />
            </svg>
            性能
          </button>
          <button class="st-nav-item" type="button" :aria-current="section === 'data' ? 'page' : undefined" @click="section = 'data'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="6" rx="8" ry="3" />
              <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
            </svg>
            数据
          </button>
          <button class="st-nav-item" type="button" :aria-current="section === 'about' ? 'page' : undefined" @click="section = 'about'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v6M12 7.6v.01" />
            </svg>
            关于
          </button>

          <div class="st-nav-foot">Aihub v{{ version }}</div>
        </nav>

        <div class="st-main">
          <SitesPage v-if="section === 'sites'" />
          <GeneralPage v-else-if="section === 'general'" />
          <HotkeyPage v-else-if="section === 'hotkey'" />
          <PerfPage v-else-if="section === 'perf'" />
          <DataPage v-else-if="section === 'data'" />
          <AboutPage v-else-if="section === 'about'" />
        </div>
      </div>
    </section>
  </div>
</template>
