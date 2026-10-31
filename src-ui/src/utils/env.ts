// 平台与通用工具，对应原 index.html 里散落的几个纯函数。

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

/** 当前是不是深色主题（由主进程的 nativeTheme.themeSource 决定） */
export function prefersDark(): boolean {
  return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
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

/** 键盘事件 -> Electron accelerator 主键名（认不出返回空） */
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
