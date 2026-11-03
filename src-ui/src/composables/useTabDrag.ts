// 标签拖拽 + 分屏投放。
//
// 雷区 2：用鼠标事件自己跟踪，不用 HTML5 拖放。
// Tauri 的 wry 在 macOS 上吞掉了 HTML5 拖放事件（dragenter/dragover/drop 不会转发给
// 页面），所以必须自己监听 mousedown/mousemove/mouseup。
//
// 雷区 3：slotRects() 的田字格算法必须和 Rust 端 compute_grid 严格一致，
// 否则拖拽预览和放下后的真实布局对不上。

import { ref } from 'vue';
import { api } from '@/api';
import { useAppStore } from '@/stores/app';
import { useOverlayStore } from '@/stores/overlay';
import { useLayoutStore } from '@/stores/layout';
import { useToast } from '@/composables/useToast';
import type { SlotRect } from '@/api/types';

const DRAG_THRESHOLD = 4; // px：手抖不算拖，点标签仍然只是点标签

interface DragState {
  id: string;
  fromX: number;
  fromY: number;
  active: boolean;
}

export interface DropTarget {
  index: number;
  occupied: boolean;
  label: string;
  ownerName: string;
  rect: SlotRect;
}

// ---- 模块级单例状态（拖拽是全局手势，跨组件共享） ----
let tabDrag: DragState | null = null;
let dragBailout = 0;
let hotZone: DropTarget | null = null;

const dragActive = ref(false);
const dragGhostName = ref('');
const dragGhostPos = ref({ x: 0, y: 0 });
const dropTargets = ref<DropTarget[]>([]);
const hotIndex = ref<number | null>(null);

// ⚠️ 这里不能在模块顶层取 Pinia store。
// main.ts 在 createPinia() 之前就 import 本模块（为了在挂载前装好全局手势），
// 顶层调用 useXxxStore() 是在 import 阶段求值的，那时 Pinia 还没装，
// 会抛「getActivePinia() was called but there was no active Pinia」。
// 所以统一改成用到时再解析。
const appStore = () => useAppStore();
const overlayStore = () => useOverlayStore();
const layoutStore = () => useLayoutStore();
const { toast } = useToast();

/** N 个格子在内容区里的位置，与 Rust compute_grid 一致：1 整屏 / 2 左右 / 3 左一右二 / 4 田字格 */
function slotRects(n: number): SlotRect[] {
  const layer = document.getElementById('dropzones');
  if (!layer) return [];
  const r = layer.getBoundingClientRect();
  const W = r.width;
  const H = r.height;
  const g = layoutStore().gap || 4;
  const halfW = Math.round((W - g) / 2);
  const rightW = W - g - halfW;
  const halfH = Math.round((H - g) / 2);
  const bottomH = H - g - halfH;

  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) {
    return [
      { x: 0, y: 0, w: halfW, h: H },
      { x: halfW + g, y: 0, w: rightW, h: H },
    ];
  }
  if (n === 3) {
    return [
      { x: 0, y: 0, w: halfW, h: H },
      { x: halfW + g, y: 0, w: rightW, h: halfH },
      { x: halfW + g, y: halfH + g, w: rightW, h: bottomH },
    ];
  }
  return [
    { x: 0, y: 0, w: halfW, h: halfH },
    { x: halfW + g, y: 0, w: rightW, h: halfH },
    { x: 0, y: halfH + g, w: halfW, h: bottomH },
    { x: halfW + g, y: halfH + g, w: rightW, h: bottomH },
  ];
}

/** 拖拽开始时按当前几何铺一遍投放区 */
function buildDropZones() {
  const cur = appStore().panes || [];
  const max = appStore().maxPanes || 4;
  const slots = Math.min(max, cur.length + (cur.length < max ? 1 : 0));
  const rects = slotRects(slots);

  dropTargets.value = rects.map((rect, i) => {
    const occupant = cur[i];
    const svc = occupant ? appStore().services.find((x) => x.id === occupant) : null;
    const label = svc
      ? svc.id === (tabDrag && tabDrag.id)
        ? '放回原位'
        : '与「' + svc.name + '」互换'
      : '放这里（新增一栏）';
    return {
      index: i,
      occupied: Boolean(svc),
      label,
      ownerName: svc ? svc.name : '',
      rect,
    };
  });
  hotIndex.value = null;
  hotZone = null;
}

/** 真开始拖之前的普通点击不该被吃掉：只有超过阈值才进拖拽模式 */
function startTabDrag() {
  if (!tabDrag) return;
  tabDrag.active = true;
  document.body.classList.add('dragging-tab');
  overlayStore().setDragYielding(true);
  buildDropZones();
  dragGhostName.value = (appStore().services.find((s) => s.id === tabDrag!.id) || {}).name || tabDrag!.id;
  dragGhostPos.value = { x: tabDrag.fromX, y: tabDrag.fromY };
  dragActive.value = true;
  // 兜底：鼠标事件丢了（系统打断、指针跑到屏幕外），让位状态会永久卡住
  clearTimeout(dragBailout);
  dragBailout = window.setTimeout(cancelTabDrag, 20000);
}

/** 收尾的唯一出口：投放框、影子、让位状态一次收拾干净 */
function cancelTabDrag() {
  clearTimeout(dragBailout);
  dragActive.value = false;
  dropTargets.value = [];
  hotIndex.value = null;
  hotZone = null;
  document.body.classList.remove('dragging-tab');
  overlayStore().setDragYielding(false);
  tabDrag = null;
}

/** 指针压在哪个标签上（跳过被拖的那个）：{ id, after } 或 null */
function tabUnder(x: number, y: number): { id: string; after: boolean } | null {
  const nodes = Array.from(document.querySelectorAll('#tabs .tab')) as HTMLElement[];
  for (const btn of nodes) {
    const id = btn.dataset.id || '';
    if (tabDrag && id === tabDrag.id) continue;
    const r = btn.getBoundingClientRect();
    if (y < r.top || y > r.bottom) continue;
    if (x < r.left - 6 || x > r.right + 6) continue;
    return { id, after: x > r.left + r.width / 2 };
  }
  return null;
}

/** 拖拽过程中根据鼠标位置点亮对应的投放区 */
function updateHotZone(clientX: number, clientY: number): boolean {
  const top = layoutStore().top || 0;
  if (clientY < top) {
    hotZone = null;
    hotIndex.value = null;
    return false;
  }
  // 命中判断用视口坐标：dropTargets.rect 是相对 #dropzones 的偏移，
  // 要加上 #dropzones 在视口里的位置换算成视口坐标。
  const layer = document.getElementById('dropzones');
  const base = layer ? layer.getBoundingClientRect() : { left: 0, top: 0 };
  const hit = dropTargets.value.find((t) => {
    const r = t.rect;
    const x = base.left + r.x;
    const y = base.top + r.y;
    return clientX >= x && clientX <= x + r.w && clientY >= y && clientY <= y + r.h;
  });
  hotZone = hit || null;
  hotIndex.value = hit ? hit.index : null;
  return Boolean(hit);
}

/** 在页面区域松手：把这个服务放进那个格子 */
async function applyDrop(dragId: string): Promise<boolean> {
  if (!hotZone) return false;
  const res = await api.placePane(dragId, hotZone.index);
  if (!res || !res.ok) {
    toast((res && res.error) || '分屏失败', true);
    return false;
  }
  return true;
}

/** 拖拽排序：只排「顶栏上看得见的」，主进程会把收起来的服务按原相对位置塞回去 */
async function moveTab(dragId: string, targetId: string, after: boolean) {
  const ids = appStore().services.filter((s) => !s.hidden).map((s) => s.id);
  const from = ids.indexOf(dragId);
  if (from < 0) return;
  ids.splice(from, 1);
  const at = ids.indexOf(targetId);
  if (at < 0) return;
  ids.splice(after ? at + 1 : at, 0, dragId);
  const res = await api.reorderServices(ids);
  if (!res || !res.ok) toast((res && res.error) || '排序失败', true);
}

export function useTabDrag() {
  /** 标签的 mousedown（绑在 tab 的 @mousedown 上） */
  function onTabMouseDown(event: MouseEvent, id: string) {
    if (event.button !== 0) return; // 只有左键拖
    if ((event.target as HTMLElement).closest('.close')) return; // × 不参与
    tabDrag = { id, fromX: event.clientX, fromY: event.clientY, active: false };
  }

  /** 全局 mousemove（在 main.ts 挂一次） */
  function onMouseMove(event: MouseEvent) {
    if (!tabDrag) return;
    if (!tabDrag.active) {
      if (Math.hypot(event.clientX - tabDrag.fromX, event.clientY - tabDrag.fromY) < DRAG_THRESHOLD) return;
      startTabDrag();
    }
    dragGhostPos.value = { x: event.clientX, y: event.clientY };
    const hit = tabUnder(event.clientX, event.clientY);
    // 每次移动都先清标记再按当前命中重标（压在标签上=换顺序，否则=分屏投放）
    clearTabDropMarks();
    if (hit) {
      markTabDrop(hit);
      hotZone = null;
      hotIndex.value = null;
    } else {
      updateHotZone(event.clientX, event.clientY);
    }
  }

  /** 全局 mouseup（在 main.ts 挂一次） */
  async function onMouseUp(event: MouseEvent) {
    if (!tabDrag || event.button !== 0) return;
    const drag = tabDrag;
    if (!drag.active) {
      tabDrag = null;
      return; // 没拖动 = 普通点击，交给 click
    }
    tabDrag = null;
    const dragEndedAt = Date.now();
    clearTimeout(dragBailout);
    dragActive.value = false;
    const hit = tabUnder(event.clientX, event.clientY);
    clearTabDropMarks();
    if (hit) {
      dropTargets.value = [];
      hotZone = null;
      hotIndex.value = null;
      document.body.classList.remove('dragging-tab');
      overlayStore().setDragYielding(false);
      await moveTab(drag.id, hit.id, hit.after);
      return;
    }
    updateHotZone(event.clientX, event.clientY); // 以松手那一刻的位置为准
    const ok = await applyDrop(drag.id);
    dropTargets.value = [];
    hotZone = null;
    hotIndex.value = null;
    document.body.classList.remove('dragging-tab');
    overlayStore().setDragYielding(false);
    if (ok) {
      api.focusPane(drag.id);
    }
    // 记下刚拖完，压掉随之而来的 click（见 main.ts 里的 click 拦截）
    lastDragEndedAt.value = dragEndedAt;
  }

  /** Esc 取消 */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && tabDrag && tabDrag.active) cancelTabDrag();
  }

  return {
    dragActive,
    dragGhostName,
    dragGhostPos,
    dropTargets,
    hotIndex,
    onTabMouseDown,
    onMouseMove,
    onMouseUp,
    onKeyDown,
  };
}

// ---- 拖拽悬停标记（drop-before / drop-after）----
function markTabDrop(hit: { id: string; after: boolean }) {
  const btn = document.querySelector(`#tabs .tab[data-id="${hit.id}"]`);
  if (btn) btn.classList.add(hit.after ? 'drop-after' : 'drop-before');
}

function clearTabDropMarks() {
  document.querySelectorAll('#tabs .tab.drop-before, #tabs .tab.drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

// 刚拖完那一下，浏览器还会补一个 click 过来——别让它顺手切换标签
const lastDragEndedAt = ref(0);

export function installTabDragGlobals() {
  const { onMouseMove, onMouseUp, onKeyDown } = useTabDrag();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener(
    'click',
    (event) => {
      if (Date.now() - lastDragEndedAt.value > 300) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}
