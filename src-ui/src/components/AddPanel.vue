<script setup lang="ts">
// 添加 AI 面板：只列还没加到标签栏上的站点，对应原 index.html 的 openAddPanel / closeAddPanel。
import { computed, ref, watch, nextTick } from 'vue';
import { useOverlayStore } from '@/stores/overlay';
import { useToast } from '@/composables/useToast';
import { iconPathFor } from '@/utils/icons';

const overlayStore = useOverlayStore();
const { toast } = useToast();

interface AvailableService {
  id: string;
  name: string;
  icon?: string;
}

const open = computed(() => overlayStore.addPanelOpen);
const items = ref<AvailableService[]>([]);
const loaded = ref(false);

// 过渡状态：open 时进入 .open，关闭时进入 .closing，等淡出结束再真正隐藏
const visible = ref(false);
const closing = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  open,
  async (now) => {
    if (now) {
      clearTimeout(closeTimer!);
      closing.value = false;
      visible.value = true;
      // 强制回流一次让 .open 的过渡真的能播
      await nextTick();
      if (!loaded.value) {
        await loadItems();
      }
      return;
    }
    // 关闭
    closing.value = true;
    clearTimeout(closeTimer!);
    closeTimer = setTimeout(() => {
      visible.value = false;
      closing.value = false;
    }, 160);
  },
);

async function loadItems() {
  try {
    items.value = await window.api.availableServices();
  } catch (err) {
    toast('读取可添加列表失败：' + err, true);
    items.value = [];
  }
  loaded.value = true;
}

function close() {
  overlayStore.setAddPanel(false);
}

async function add(svc: AvailableService, btn: HTMLButtonElement) {
  btn.disabled = true;
  const res = await window.api.addBuiltin(svc.id);
  if (!res || !res.ok) {
    btn.disabled = false;
    return toast((res && res.error) || '添加失败', true);
  }
  toast('已添加「' + svc.name + '」到标签栏');
  close();
}

function goCustom() {
  // 自定义网站走设置面板那套表单
  close();
  overlayStore.setSettings(true);
  setTimeout(() => {
    document.getElementById('add-name')?.focus();
  }, 220);
}

function onBackdrop(event: MouseEvent) {
  if ((event.target as HTMLElement).classList.contains('ap-backdrop')) close();
}

// 入场错开 30ms 一个：一起冒出来会糊成一团
function onItemMounted(el: unknown, svc: AvailableService) {
  if (!(el instanceof HTMLElement)) return;
  const index = items.value.findIndex((s) => s.id === svc.id);
  el.style.opacity = '0';
  el.style.transform = 'translateY(6px)';
  requestAnimationFrame(() => {
    el.style.transition =
      'opacity var(--dur-2) var(--ease-out) ' + index * 30 + 'ms, ' +
      'transform var(--dur-2) var(--ease-out) ' + index * 30 + 'ms';
    el.style.opacity = '';
    el.style.transform = '';
  });
}

// Esc 关闭由 App.vue 统一处理
</script>

<template>
  <div
    v-if="visible"
    id="addpanel"
    :class="{ open, closing }"
    @click="onBackdrop"
  >
    <div class="ap-backdrop"></div>
    <section class="ap-card" role="dialog" aria-modal="true" aria-label="添加 AI">
      <header>
        <h2>添加 AI</h2>
        <button class="icon-btn" id="ap-close" title="关闭（Esc）" aria-label="关闭" @click="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>
      <div class="ap-body">
        <div class="ap-grid" id="ap-grid">
          <button
            v-for="svc in items"
            :key="svc.id"
            class="ap-item"
            type="button"
            :aria-label="'添加 ' + svc.name"
            :ref="(el) => onItemMounted(el, svc)"
            @click="add(svc, $event.currentTarget as HTMLButtonElement)"
          >
            <img v-if="iconPathFor(svc.icon)" :src="iconPathFor(svc.icon)" alt="" />
            <span>{{ svc.name }}</span>
          </button>
        </div>
        <p class="ap-empty" id="ap-empty" :hidden="items.length > 0">
          所有内置站点都已经在标签栏上了。<br />想加别家？到设置里填名字和网址。
        </p>
      </div>
      <footer>
        <button class="btn ghost" id="ap-custom" @click="goCustom">添加自定义网站…</button>
      </footer>
    </section>
  </div>
</template>

<script lang="ts">
export default { name: 'AddPanel' };
</script>
