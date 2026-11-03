// 平台判断与几个纯工具函数。

import { ref } from 'vue';

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

/** 从 URL 里取 host（认不出返回空串） */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** HTML 转义 */
export function escapeHtml(text: unknown): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

/**
 * 当前是不是深色主题。主题由窗口设置，切换后媒体查询会跟着变。
 *
 * 状态存在 ref 里、而不是每次现读 matchMedia(...).matches：
 * 内置 logo 的深/浅变体靠它取舍，读取方是 computed，
 * 纯函数不产生响应式依赖，主题变了图标不会重算。
 */
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const darkRef = ref(!darkQuery || darkQuery.matches);

if (darkQuery) {
  const sync = () => {
    darkRef.value = darkQuery.matches;
  };
  // 老 WebView 只有已废弃的 addListener
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', sync);
  else if (darkQuery.addListener) darkQuery.addListener(sync);
}

/** 当前是不是深色主题（响应式：主题切换后读它的 computed 会自动重算） */
export function prefersDark(): boolean {
  return darkRef.value;
}

/** "Command+Shift+Space" -> mac 显示 "⌘⇧Space"，其它平台原样返回 */
const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧',
  Command: '⌘', Cmd: '⌘', Super: '⌘', Meta: '⌘',
};

export function prettyAccel(acc: string | undefined | null): string {
  const text = String(acc || '');
  if (!IS_MAC || !text) return text;
  const parts = text.split('+');
  const key = parts.pop();
  return parts.map((m) => MAC_SYMBOLS[m] || m + '+').join('') + key;
}

/** 键盘事件 -> 快捷键 accelerator 的主键名（认不出返回空） */
export function keyNameFromEvent(event: KeyboardEvent): string {
  const code = event.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter',
    Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Minus: '-', Equal: '=', Backquote: '`',
  };
  return named[code] || '';
}

/** 修饰键按主进程固定顺序拼，保证写法前后一致 */
export function acceleratorFromEvent(event: KeyboardEvent): string {
  const key = keyNameFromEvent(event);
  if (!key) return '';
  const mods: string[] = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push(IS_MAC ? 'Command' : 'Super');
  return mods.concat(key).join('+');
}
