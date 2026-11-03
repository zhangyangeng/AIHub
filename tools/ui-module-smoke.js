/**
 * 前端模块加载冒烟检查。
 *
 *   node --experimental-strip-types tools/ui-module-smoke.js
 *
 * 背景：外壳页白屏在 CI 里是看不出来的——进程照样起得来，构建也照样能过。
 * 白屏的成因通常是**模块顶层求值就抛错**（例如在 Pinia 安装前调用 useStore()），
 * 一旦发生，整个模块图失败，#app 里什么都挂不上。
 *
 * 这里直接把前端源码的模块图加载一遍，确认：
 *   1. 每个模块都能被求值（不依赖任何挂载顺序）
 *   2. window.api 在加载后就存在（少了它所有按钮都是哑的）
 *
 * 注意：加载顺序故意是「先 useTabDrag 再其它」——它曾经在顶层取 store，
 * 是整个应用挂不上的元凶。
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { register } = require('node:module');

// --- 最小化的浏览器环境 ---
const noop = () => {};
const mediaQuery = { matches: false, addEventListener: noop, removeEventListener: noop };
globalThis.window = {
  __TAURI__: {
    core: { invoke: () => Promise.resolve({}) },
    event: { listen: () => Promise.resolve(noop) },
  },
  matchMedia: () => mediaQuery,
  addEventListener: noop,
  removeEventListener: noop,
  location: { href: 'http://localhost/' },
};
globalThis.document = {
  body: { classList: { add: noop, remove: noop, contains: () => false } },
  documentElement: { classList: { add: noop, remove: noop, contains: () => false } },
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
};

// 让 `@/` 能被解析到 src-ui/src/
register(pathToFileURL(path.join(__dirname, 'alias-hooks.mjs')).href);

const load = (rel) =>
  import(pathToFileURL(path.join(__dirname, '..', 'src-ui', 'src', rel)).href);

(async () => {
  let bad = 0;

  // 顺序有意为之：这个模块曾在顶层取用 Pinia store，导致整个应用挂不上
  for (const rel of [
    'composables/useTabDrag.ts',
    'composables/useDividerDrag.ts',
    'composables/useToast.ts',
    'stores/app.ts',
    'stores/layout.ts',
    'stores/overlay.ts',
    'utils/env.ts',
    'utils/icons.ts',
    'api/index.ts',
  ]) {
    try {
      await load(rel);
      console.log(`✅ ${rel}`);
    } catch (e) {
      console.log(`❌ ${rel} 加载失败：${e.message}`);
      bad += 1;
    }
  }

  // window.api 必须被挂上，否则组件里所有调用都是 undefined
  if (typeof globalThis.window.api === 'undefined') {
    console.log('❌ window.api 没有被挂上（按钮会全是哑的）');
    bad += 1;
  } else if (typeof globalThis.window.api.getState !== 'function') {
    console.log('❌ window.api.getState 不是函数');
    bad += 1;
  } else {
    console.log('✅ window.api 已就绪');
  }

  // 别名钩子生效校验：经 `@/` 导入的 api 必须和 window.api 是同一个实例
  try {
    const viaAlias = await import('@/api');
    if (viaAlias.api !== globalThis.window.api) {
      console.log('❌ 经别名导入的 api 与 window.api 不是同一个实例');
      bad += 1;
    } else {
      console.log('✅ 别名解析正常，模块实例一致');
    }
  } catch (e) {
    console.log(`❌ @/ 别名解析失败：${e.message}`);
    bad += 1;
  }

  console.log(bad ? `\n${bad} 项未通过` : '\n全部通过');
  process.exit(bad ? 1 : 0);
})();
