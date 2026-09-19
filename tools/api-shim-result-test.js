/**
 * 账号迁移那两个方法的返回值形状回归。
 *
 *   node tools/api-shim-result-test.js
 *
 * 背景：index.html 里所有 handler 都是照 Electron 的返回值形状写的
 * （`const res = await ...; if (!res.ok) ...`），一个 try 都没套。而 Tauri 的
 * invoke 在 Rust 返回 Err 时是 **reject** —— handler 会在 await 那行直接中断，
 * `migrateButtons(false)` 和报错提示全都跑不到，用户看到的是「按钮永久变灰、
 * 没有任何解释」。这个测试盯的就是这条：Err 必须**变成值**回来。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// 随便一个 Rust 侧真会返回的 Err —— 比如导出时磁盘写不进去
const ERR = '写入文件失败：拒绝访问 (os error 5)';
const win = {
  __TAURI__: {
    core: { invoke: () => Promise.reject(new Error(ERR)) },
    event: { listen: () => Promise.resolve(() => {}) },
  },
};
const ctx = { window: win, console, setTimeout, clearTimeout, document: { cookie: '' } };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src-ui', 'api-shim.js'), 'utf8'), ctx);

(async () => {
  let bad = 0;
  for (const [name, call] of [
    ['exportLogin', () => win.api.exportLogin('')],
    ['importLogin', () => win.api.importLogin({ file: 'x', dryRun: true })],
  ]) {
    let res;
    try {
      res = await call();
    } catch (e) {
      console.log(`❌ ${name} 把错误抛了出去（handler 会就地中断）：${e.message}`);
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
