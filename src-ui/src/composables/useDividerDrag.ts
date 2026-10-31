// 分隔条拖拽 composable：对应原 index.html 的 onDividerDown / onDividerMove / onDividerUp。
//
// 雷区 1：节流用时间戳 + setTimeout，刻意不用 requestAnimationFrame。
// 窗口被其它窗口遮挡时 Chromium 会暂停出帧，rAF 不再触发，拖拽就会卡死。

import { api } from '@/api';
import type { LayoutGeometry } from '@/api/types';

type DividerInfo = LayoutGeometry['dividers'][number];

interface DragState {
  index: number;
  pointerId: number;
  el: HTMLElement;
  x: number;
  sentAt: number;
  timer: number;
}

let drag: DragState | null = null;

function onDividerMove(event: PointerEvent) {
  if (!drag) return;
  drag.x = event.clientX;
  const now = performance.now();
  if (now - drag.sentAt < 8) {
    if (!drag.timer) {
      drag.timer = window.setTimeout(() => {
        if (!drag) return;
        drag.timer = 0;
        drag.sentAt = performance.now();
        api.dragDivider(drag.index, drag.x);
      }, 8);
    }
    return;
  }
  drag.sentAt = now;
  api.dragDivider(drag.index, drag.x);
}

function onDividerUp() {
  finishDrag();
}

function finishDrag(extra?: Record<string, unknown>) {
  if (!drag) return;
  const current = drag;
  drag = null;
  if (current.timer) clearTimeout(current.timer);
  current.el.classList.remove('dragging');
  document.body.classList.remove('resizing');
  window.removeEventListener('pointermove', onDividerMove);
  window.removeEventListener('pointerup', onDividerUp);
  window.removeEventListener('pointercancel', onDividerUp);
  window.removeEventListener('blur', onDividerUp);
  api.endDrag(Object.assign({ index: current.index }, extra || {}));
}

export function useDividerDrag() {
  /** 按下分隔条开始拖拽（绑在 divider 的 @pointerdown 上） */
  function onDividerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    if (drag) finishDrag(); // 上一次手势没收到 pointerup 时兜底
    const el = event.currentTarget as HTMLElement;
    drag = {
      index: Number(el.dataset.index) || 0,
      pointerId: event.pointerId,
      el,
      x: event.clientX,
      sentAt: 0,
      timer: 0,
    };
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略 */
    }
    event.preventDefault();
    window.addEventListener('pointermove', onDividerMove);
    window.addEventListener('pointerup', onDividerUp);
    window.addEventListener('pointercancel', onDividerUp);
    window.addEventListener('blur', onDividerUp);
  }

  /** 双击分隔条 = 均分两栏 */
  function onDividerDoubleClick(event: MouseEvent) {
    event.preventDefault();
    const el = event.currentTarget as HTMLElement;
    api.endDrag({ index: Number(el.dataset.index) || 0, equalize: true });
  }

  /** 分隔条的几何样式（left / width），热区比视觉缝隙宽 */
  function dividerStyle(info: DividerInfo) {
    return {
      left: (info.hitX != null ? info.hitX : info.x) + 'px',
      width: (info.hitWidth != null ? info.hitWidth : info.width) + 'px',
    };
  }

  return { onDividerDown, onDividerDoubleClick, dividerStyle };
}

// 页面任何地方的新按下都意味着上一次拖拽手势已经结束。
// 在 main.ts 里挂一次（对应原代码 document.addEventListener('pointerdown', ...)）。
export function installDividerCleanup() {
  document.addEventListener(
    'pointerdown',
    () => {
      if (drag) finishDrag();
    },
    true,
  );
}
