<script setup lang="ts">
// 标签栏：渲染顶栏服务，以及选中 / 分屏 / 加载 / 休眠状态，处理点击、拖拽与关闭页面。
// 注意：这里的 ✕ 关的是「页面」，标签本身留在顶栏；把站点从顶栏收起的入口在设置-站点里。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

const tabsEl = ref<HTMLElement | null>(null);

/**
 * 顶栏内宽（#bar 的 clientWidth，含它的左右 padding）。
 *
 * 这里特意量父容器而不是 #tabs 自己：紧凑模式会隐藏主机名，主机名一消失 #tabs 就变宽，
 * 变宽后又可能判定「不用紧凑了」，来回抖动。量 #bar 就不会——它只跟窗口宽度走。
 */
const barWidth = ref(0);

/** 每个标签要显示文字至少得有 86px：左内边距 12 + 图标 16 + 间隙 6 + 约 4 个字 + ✕ 槽位 20 */
const MIN_TEXT_TAB = 86;
const TAB_GAP = 4;
/** 顶栏里不归标签用的固定开销：左右 padding 16 + 三个栏间 gap 24 + 工具栏四个按钮 126 + 分隔最小宽 12 */
const BAR_FURNITURE = 16 + 24 + 126 + 12;
/** 文字模式下还要给主机名留位置（它最多 220px，实际常在一百出头，按 120 估） */
const HOST_RESERVE = 120;

/**
 * 紧凑模式：标签栏放不下「图标 + 至少几个字」时，整条统一退化成只显示图标。
 *
 * 为什么不做「每个标签各自缩到极限」：文字区一旦落到 1~18px，省略号放不下，
 * 浏览器只会切出半个字形（「彐」「卜」这种），看着像渲染坏了。
 * 与其这样，不如干脆不显示文字——图标才是辨认站点的关键。
 */
const compact = computed(() => {
  const n = shown.value.length;
  if (!n || barWidth.value <= 0) return false;
  const need = n * MIN_TEXT_TAB + (n - 1) * TAB_GAP;
  return barWidth.value - BAR_FURNITURE - HOST_RESERVE < need;
});

/**
 * 把当前标签滚进可视区。
 *
 * 窗口变窄后标签会缩到下限，再放不下就横向溢出。溢出时滚动条是隐藏的
 * （`scrollbar-width: none`），新加的站点很可能刚好在可视区外，看着就像「没加进去」。
 * 所以激活哪个就保证它在视野里，且只在本来看不见时才滚，避免每次点击都打断用户。
 */
async function revealActive() {
  await nextTick();
  const el = tabsEl.value;
  const id = appStore.activeId;
  if (!el || !id) return;
  const tab = el.querySelector<HTMLElement>(`.tab[data-id="${CSS.escape(id)}"]`);
  if (!tab) return;
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  const viewLeft = el.scrollLeft;
  const viewRight = viewLeft + el.clientWidth;
  if (left < viewLeft) el.scrollTo({ left: left - 4, behavior: 'smooth' });
  else if (right > viewRight) el.scrollTo({ left: right - el.clientWidth + 4, behavior: 'smooth' });
}

watch(() => [appStore.activeId, shown.value.length], revealActive, { immediate: true });

// 窗口宽度变化 → 重新判断要不要进紧凑模式；进出紧凑模式会改变标签宽度，
// 所以顺带再校一次滚动位置（当前那个标签不能因为变宽变窄而跑出视野）
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const bar = tabsEl.value?.parentElement;
  if (!bar) return;
  barWidth.value = bar.clientWidth;
  resizeObserver = new ResizeObserver((entries) => {
    // 用 clientWidth（含 padding），和 BAR_FURNITURE 里的 16px 内边距口径一致
    const target = entries[0]?.target as HTMLElement | undefined;
    const w = target?.clientWidth ?? 0;
    if (Math.abs(w - barWidth.value) < 1) return;
    barWidth.value = w;
    revealActive();
  });
  resizeObserver.observe(bar);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

/** 标签栏溢出时把纵向滚轮借来横向滚，否则鼠标用户没法翻到后面的标签 */
function onWheel(event: WheelEvent) {
  const el = tabsEl.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return; // 触控板的横向滑动交给浏览器
  el.scrollLeft += event.deltaY;
  event.preventDefault();
}

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

/**
 * 中键点击标签 = 关闭该页面。
 *
 * 这是 ✕ 之外的快捷方式，宽窄两种模式都成立：中键在哪都是关，行为不随窗口宽度变化。
 * （重载当前标签仍有工具栏按钮和 F5，中键原来那个 reload 是冗余的非标准操作。）
 */
function onAuxClick(event: MouseEvent, svc: Service) {
  if (event.button === 1) {
    event.preventDefault();
    // 和 ✕ 的显隐规则对齐：只剩一个标签时不关，别把应用关成空壳
    if (onlyOne.value) return;
    onClose(svc);
  }
}

function onContextMenu(event: MouseEvent, svc: Service) {
  event.preventDefault();
  event.stopPropagation();
  appStore.togglePane(svc.id);
}

async function onClose(svc: Service) {
  const res = await api.close(svc.id);
  if (!res || !res.ok) return toast((res && res.error) || '关闭失败', true);
  toastAction(
    '已关闭「' + svc.name + '」的页面',
    '重新打开',
    () => appStore.activate(svc.id),
    6000,
  );
}
</script>

<template>
  <div id="tabs" ref="tabsEl" role="tablist" :class="{ compact }" @wheel="onWheel">
    <button
      v-for="svc in shown"
      :key="svc.id"
      class="tab"
      :class="{ active: isActive(svc), pane: isPane(svc) }"
      :data-id="svc.id"
      :data-error="hasError(svc) ? '1' : '0'"
      :data-hibernated="isHibernated(svc) ? '1' : '0'"
      :data-closable="onlyOne ? '0' : '1'"
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
        title="关闭页面"
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
