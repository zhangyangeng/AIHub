// Toast 提示 composable：对应原 index.html 的 toast() / toastAction()。
// 全局单例，供任何组件调用。

import { ref } from 'vue';

const visible = ref(false);
const isError = ref(false);
const sticky = ref(false);
const message = ref('');
const actionLabel = ref('');
const actionHandler = ref<(() => void) | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

/** 普通提示，2.6 秒后自动消失 */
function toast(text: string, error = false) {
  clearTimer();
  message.value = text;
  actionLabel.value = '';
  actionHandler.value = null;
  sticky.value = false;
  isError.value = error;
  visible.value = true;
  toastTimer = setTimeout(() => (visible.value = false), 2600);
}

/**
 * 带一个按钮的 toast。
 * 默认不会自己消失，用在「等用户做个决定」的场合（比如自动更新的「立即重启」）。
 * 传 ms 则是「撤销」这类：不做决定也没关系，过一会儿自己收掉。
 */
function toastAction(text: string, label: string, onClick: () => void, ms = 0) {
  clearTimer();
  message.value = text;
  actionLabel.value = label;
  actionHandler.value = onClick;
  isError.value = false;
  sticky.value = true;
  visible.value = true;
  if (ms > 0) {
    toastTimer = setTimeout(() => {
      visible.value = false;
      sticky.value = false;
    }, ms);
  }
}

function dismiss() {
  clearTimer();
  visible.value = false;
  sticky.value = false;
  if (actionHandler.value) {
    const fn = actionHandler.value;
    actionHandler.value = null;
    fn();
  }
}

export function useToast() {
  return {
    visible,
    isError,
    sticky,
    message,
    actionLabel,
    toast,
    toastAction,
    dismiss,
  };
}
