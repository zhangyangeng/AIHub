/**
 * 账号迁移那两个方法的返回值形状回归。
 *
 *   node --experimental-strip-types tools/api-result-test.js
 *
 * 背景：调用方都是照 `const res = await ...; if (!res.ok) ...` 写的，一个 try 都没套。
 * 而 Tauri 的 invoke 在 Rust 返回 Err 时是 **reject** —— 调用方会在 await 那行直接中断，
 * 按钮复位和报错提示全都跑不到，用户看到的是「按钮永久变灰、没有任何解释」。
 * 这个测试盯的就是这条：Err 必须**变成值**回来。
 *
 * 前端是 TS 工程，这里用 Node 自带的类型剥离直接加载源码，不需要先打包。
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

// 随便一个 Rust 侧真会返回的 Err —— 比如导出时磁盘写不进去
const ERR = '写入文件失败：拒绝访问 (os error 5)';

// 源码在模块顶层读 window.__TAURI__，所以必须先把它挂好再加载
globalThis.window = {
  __TAURI__: {
    core: { invoke: () => Promise.reject(new Error(ERR)) },
    event: { listen: () => Promise.resolve(() => {}) },
  },
};

(async () => {
  const entry = pathToFileURL(path.join(__dirname, '..', 'src-ui', 'src', 'api', 'index.ts')).href;
  const { api } = await import(entry);

  let bad = 0;
  for (const [name, call] of [
    ['exportLogin', () => api.exportLogin('')],
    ['importLogin', () => api.importLogin({ file: 'x', dryRun: true })],
  ]) {
    let res;
    try {
      res = await call();
    } catch (e) {
      console.log(`❌ ${name} 把错误抛了出去（调用方会就地中断）：${e.message}`);
      bad += 1;
      continue;
    }
    const ok = res && res.ok === false && String(res.error).includes('写入文件失败');
    console.log(`${ok ? '✅' : '❌'} ${name} → ${JSON.stringify(res)}`);
    if (!ok) bad += 1;
  }
  console.log(bad ? `\n${bad} 项未通过` : '\n全部通过');
  process.exit(bad ? 1 : 0);
})();
