// 内置站点图标解析，对应原 index.html 的 ICON_TABLE / builtinIconKey / iconPathFor / builtinIcon。
// 图标表由 public/icons.js 在运行时注入 window.AIHUB_ICONS。

import { prefersDark, hostOf } from '@/utils/env';
import type { Service } from '@/api/types';

type IconTable = {
  files?: Record<string, string>;
  variants?: Record<string, { dark?: string; light?: string }>;
  hosts?: Record<string, string>;
  aliases?: Record<string, string>;
};

function table(): IconTable {
  return (window.AIHUB_ICONS && window.AIHUB_ICONS) || { files: {}, variants: {}, hosts: {}, aliases: {} };
}

/** 服务 -> 内置图标 key（认不出返回空串） */
export function builtinIconKey(svc: Service): string {
  const t = table();
  const files = t.files || {};
  const aliases = t.aliases || {};
  const hosts = t.hosts || {};

  const pick = (key?: string): string => {
    if (!key) return '';
    if (files[key]) return key;
    const alias = aliases[key];
    if (alias && files[alias]) return alias;
    return '';
  };

  let hit = pick(svc.icon);
  if (!hit) {
    const raw = String(svc.icon || '').trim().toLowerCase();
    if (raw) hit = pick(raw);
  }
  if (!hit) {
    const host = hostOf(svc.url).toLowerCase().replace(/^www\./, '');
    if (host) {
      hit = pick(hosts[host]);
      if (!hit) {
        const parts = host.split('.');
        for (let i = 1; i < parts.length && !hit; i += 1) hit = pick(hosts[parts.slice(i).join('.')]);
      }
      if (!hit) {
        const flat = host.replace(/[^a-z0-9]/g, '');
        for (const key of Object.keys(files)) {
          if (key.length >= 4 && flat.includes(key)) {
            hit = key;
            break;
          }
        }
      }
    }
  }
  if (!hit) {
    const name = String(svc.name || '').trim().toLowerCase();
    if (name) hit = pick(name);
  }
  return hit;
}

/** 图标 key -> 当前主题下该加载的文件；深/浅主题各有一套变体，避免给 logo 垫白底 */
export function iconPathFor(key: string | undefined | null): string {
  if (!key) return '';
  const t = table();
  const base = (t.files || {})[key] || '';
  const variant = (t.variants || {})[key] || {};
  const path = prefersDark() ? variant.dark || base : variant.light || base;
  return path || base;
}

/** 服务 -> 当前主题下该用的内置图标路径（认不出返回空） */
export function builtinIcon(svc: Service): string {
  return iconPathFor(builtinIconKey(svc));
}
