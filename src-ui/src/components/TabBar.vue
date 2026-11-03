<script setup lang="ts">
// 标签栏：渲染顶栏服务，以及选中 / 分屏 / 加载 / 休眠状态，处理点击、拖拽与收起。
import { computed } from 'vue';
import { useAppStore, useStatusStore } from '@/stores/app';
import { builtinIcon } from '@/utils/icons';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { useTabDrag } from '@/composables/useTabDrag';
import type { Service } from '@/api/types';

const appStore = useAppStore();
const statusStore = useStatusStore();
const { toast, toastAction } = useToast();
const { onTabMouseDown } = useTabDrag();

/** 顶栏可见的服务（收起的不显示） */
const shown = computed(() => appStore.services.filter((s) => !s.hidden));

const onlyOne = computed(() => shown.value.length <= 1);

/** 单个标签的运行时状态 */
function statusOf(id: string) {
  return statusStore.statusOf(id);
}

/** 标签的图标 src：内置 logo 优先，没有才用网站 favicon */
function iconSrc(svc: Service): string {
  const st = statusOf(svc.id);
  return builtinIcon(svc) || st.favicon || '';
}

function isLocalIcon(svc: Service): boolean {
  return Boolean(builtinIcon(svc));
}

/** 标签的 title（含分屏栏位 / 焦点 / 休眠标记） */
function tabTitle(svc: Service): string {
  const st = statusOf(svc.id);
  const paneIndex = appStore.panes.indexOf(svc.id);
  const marks: string[] = [];
  if (paneIndex >= 0 && appStore.panes.length > 1) marks.push(`分屏第 ${paneIndex + 1} 栏`);
  if (svc.id === appStore.activeId) marks.push('当前焦点');
  if (st.hibernated) marks.push('已休眠 · 点开自动恢复');
  const base = st.title ? svc.name + ' — ' + st.title : svc.name + '\n' + svc.url;
  return base + (marks.length ? '\n（' + marks.join(' · ') + '）' : '');
}

function isActive(svc: Service): boolean {
  return svc.id === appStore.activeId;
}

function isPane(svc: Service): boolean {
  return appStore.panes.indexOf(svc.id) >= 0;
}

function showSpin(svc: Service): boolean {
  return Boolean(statusOf(svc.id).loading);
}

function hasError(svc: Service): boolean {
  return Boolean(statusOf(svc.id).error);
}

function isHibernated(svc: Service): boolean {
  return Boolean(statusOf(svc.id).hibernated);
}

function dotColor(svc: Service): string {
  return svc.color || '';
}

function onClick(svc: Service) {
  appStore.activate(svc.id);
}

function onAuxClick(event: MouseEvent, svc: Service) {
  if (event.button === 1) {
    event.preventDefault();
    api.reload(svc.id);
  }
}

function onContextMenu(event: MouseEvent, svc: Service) {
  event.preventDefault();
  event.stopPropagation();
  appStore.togglePane(svc.id);
}

async function onClose(svc: Service) {
  const res = await api.setServiceHidden(svc.id, true);
  if (!res || !res.ok) return toast((res && res.error) || '收起失败', true);
  toastAction(
    '已收起「' + svc.name + '」，可在设置里放回来',
    '撤销',
    async () => {
      const back = await api.setServiceHidden(svc.id, false);
      if (!back || !back.ok) toast((back && back.error) || '放回失败', true);
    },
    6000,
  );
}
</script>

<template>
  <div id="tabs" role="tablist">
    <button
      v-for="svc in shown"
      :key="svc.id"
      class="tab"
      :class="{ active: isActive(svc), pane: isPane(svc) }"
      :data-id="svc.id"
      :data-error="hasError(svc) ? '1' : '0'"
      :data-hibernated="isHibernated(svc) ? '1' : '0'"
      :title="tabTitle(svc)"
      :style="dotColor(svc) ? { '--dot': dotColor(svc) } : undefined"
      draggable="false"
      @click="onClick(svc)"
      @auxclick="onAuxClick($event, svc)"
      @contextmenu="onContextMenu($event, svc)"
      @mousedown="onTabMouseDown($event, svc.id)"
    >
      <img
        v-if="iconSrc(svc)"
        class="fav"
        :src="iconSrc(svc)"
        :data-local="isLocalIcon(svc) ? '1' : '0'"
        alt=""
      />
      <span v-else class="dot"></span>
      <span class="name">{{ svc.name }}</span>
      <span v-show="showSpin(svc)" class="spin"></span>
      <span
        v-show="!onlyOne"
        class="close"
        role="button"
        title="从顶栏收起（登录状态保留，可在设置里放回来）"
        @click.stop.prevent="onClose(svc)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </button>
  </div>
</template>
