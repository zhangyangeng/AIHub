/**
 * 把 `@/xxx` 解析到 src-ui/src/xxx，供 tools/ui-module-smoke.js 直接加载 TS 源码。
 *
 * 解析顺序与打包器一致：先补 .ts，再退到目录下的 index.ts。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src-ui/src/', import.meta.url);

function pick(rel) {
  if (/\.[a-z]+$/i.test(rel)) return rel;
  for (const candidate of [rel + '.ts', rel + '/index.ts']) {
    if (existsSync(fileURLToPath(new URL(candidate, SRC)))) return candidate;
  }
  return rel + '.ts';
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return nextResolve(new URL(pick(specifier.slice(2)), SRC).href, context);
  }
  return nextResolve(specifier, context);
}
