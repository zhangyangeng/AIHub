<script setup lang="ts">
// 设置里的一行服务：图标、名称、域名、状态徽标，操作收在行尾菜单里。
//
// 为什么不再把输入框和四个按钮平铺出来：名称和网址绝大多数时候不用改，
// 常驻编辑态会让每一行看起来都「待保存」，十几个服务叠起来就是一片按钮。
import { computed, nextTick, ref, watch } from 'vue';
import type { Service } from '@/api/types';
import { useAppStore } from '@/stores/app';
import { useOverlayStore } from '@/stores/overlay';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { builtinIcon } from '@/utils/icons';
import { hostOf } from '@/utils/env';

const props = defineProps<{
  svc: Service;
  menuOpen: boolean;
  paneCount?: number;
  paneIds?: string[];
}>();

const emit = defineEmits<{
  (e: 'menu', id: string | null): void;
  (e: 'edit', svc: Service): void;
  (e: 'remove', svc: Service): void;
}>();

const overlayStore = useOverlayStore();
const appStore = useAppStore();
const { toast } = useToast();

const iconSrc = computed(() => builtinIcon(props.svc));
const host = computed(() => hostOf(props.svc.url) || props.svc.url);

const inPane = computed(() => (props.paneIds || []).indexOf(props.svc.id) >= 0);
const badge = computed(() => {
  if (props.svc.hidden) return '已收起';
  if (inPane.value && (props.paneCount || 0) > 1) return '分屏中';
  if (!props.svc.custom) return '内置';
  return '';
});

// 菜单挂在 body 上，按按钮位置算坐标。原来是贴着行往下展开的 absolute 定位，
// 行在 .st-main 这个滚动容器里，靠近底部的行会把菜单连同「删除服务…」一起裁掉。
const moreEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuStyle = ref<{ top: string; left: string; visibility: 'hidden' | 'visible' }>({
  top: '0px',
  left: '0px',
  visibility: 'hidden',
});

async function placeMenu() {
  if (!props.menuOpen) return;
  await nextTick();
  const anchor = moreEl.value;
  const menu = menuEl.value;
  if (!anchor || !menu) return;

  const a = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const gap = 6;
  const edge = 8;

  // 下方放不下就翻到上方；上下都放不下时贴住可见区底部，不越界
  let top = a.bottom + gap;
  if (top + height > window.innerHeight - edge) {
    const above = a.top - gap - height;
    top = above >= edge ? above : Math.max(edge, window.innerHeight - edge - height);
  }

  const left = Math.min(Math.max(edge, a.right - width), window.innerWidth - edge - width);
  menuStyle.value = {
    top: Math.round(top) + 'px',
    left: Math.round(left) + 'px',
    visibility: 'visible',
  };
}

watch(
  () => props.menuOpen,
  (open) => {
    if (!open) return;
    // 先藏起来再量，否则会在 (0,0) 闪一帧
    menuStyle.value = { top: '0px', left: '0px', visibility: 'hidden' };
    void placeMenu();
  }
);

function toggleMenu() {
  emit('menu', props.menuOpen ? null : props.svc.id);
}

function edit() {
  emit('menu', null);
  emit('edit', props.svc);
}

function remove() {
  emit('menu', null);
  emit('remove', props.svc);
}

async function toggleHidden() {
  emit('menu', null);
  const res = await api.setServiceHidden(props.svc.id, !props.svc.hidden);
  if (!res || !res.ok) return toast((res && res.error) || '操作失败', true);
  toast(props.svc.hidden ? '已放回「' + props.svc.name + '」' : '已收起「' + props.svc.name + '」');
}

function openDevtools() {
  emit('menu', null);
  api.activate(props.svc.id);
  overlayStore.setSettings(false);
  api.devtools(props.svc.id);
}
</script>

<template>
  <div class="st-item" :class="{ 'is-hidden': svc.hidden }">
    <span class="st-logo" :style="{ '--dot': svc.color }">
      <img v-if="iconSrc" :src="iconSrc" alt="" />
      <span v-else class="dot"></span>
    </span>

    <span class="st-item-main">
      <span class="st-item-name">{{ svc.name }}</span>
      <span class="st-item-host">{{ host }}</span>
    </span>

    <span v-if="badge" class="st-badge" :class="{ accent: badge === '分屏中' }">{{ badge }}</span>

    <button
      ref="moreEl"
      class="st-more"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="menuOpen ? 'true' : 'false'"
      :aria-label="'「' + svc.name + '」的操作'"
      @click.stop="toggleMenu"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.7" />
        <circle cx="12" cy="12" r="1.7" />
        <circle cx="19" cy="12" r="1.7" />
      </svg>
    </button>

    <Teleport to="body">
      <div
        v-if="menuOpen"
        ref="menuEl"
        class="st-menu"
        role="menu"
        :style="menuStyle"
        @click.stop
      >
        <button type="button" role="menuitem" @click="edit">编辑名称与网址</button>
        <button type="button" role="menuitem" @click="toggleHidden">{{ svc.hidden ? '放回顶栏' : '从顶栏收起' }}</button>
        <button v-if="appStore.devtools === true" type="button" role="menuitem" @click="openDevtools">打开开发者工具</button>
        <hr />
        <button type="button" role="menuitem" class="danger" @click="remove">删除服务…</button>
      </div>
    </Teleport>
  </div>
</template>
