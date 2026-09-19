/**
 * 账号迁移的真机自检（Tauri debug 构建专用）。
 *
 *   cd src-tauri
 *   SCRATCH="$TEMP/aihub-migtest-profile" && rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
 *   AIHUB_CONFIG_DIR="$SCRATCH" \
 *   TAURI_CONFIG='{"identifier":"io.github.openx123.aihub.migtest"}' \
 *   AIHUB_LOGIN_EXPORT_TO="$SCRATCH/export.json" \
 *   AIHUB_SELFTEST=../tools/login-migration-selftest.js cargo run
 *
 * 两个环境变量各管一件事，**缺一不可**：
 *
 *   TAURI_CONFIG 换 identifier —— 只避开单实例锁（否则已经有 Aihub 在跑时，
 *     这个测试实例会静默退出，看起来像「什么都没发生」）；
 *   AIHUB_CONFIG_DIR         —— 才是真正换数据目录的那个。
 *
 * ⚠️ 别以为换了 identifier 就隔离了。`config_dir()` 写死 %APPDATA%/Aihub，
 * identifier 换了它也不变。只换 identifier 的后果是实打实的：这条自检会把**你
 * 真实的登录态**明文导出到磁盘上，并且和正在运行的 Aihub 抢同一个 WebView2
 * 用户数据目录 —— 满屏 `failed to receive message from webview`，看起来像代码
 * 有 bug，其实只是在抢锁。这个坑我们踩过。
 *
 * ## 它验什么
 *
 * 纯函数那一层（文件格式、加解密、服务匹配）归 `cargo test`，这里不重复。
 * 这里只验**只有真机才暴露得出来**的三件事：
 *
 *   1. **死锁**：导出要逐个服务建临时 webview（add_child）、等页面就绪、eval 读
 *      本地存储、读 cookie —— 这四件事全是「阻塞当前线程等主线程派发回调」。
 *      命令写成同步的就会自己等自己，表现为「一直没有结果」。
 *   2. **写回真的被接受**：`set_cookie` 会不会被 WebView2 拒。这条只能真写一次才知道，
 *      失败数不为 0 就是红。
 *   3. **写回真的落盘**：再导一次看数量还在不在。set_cookie 返回 Ok 不等于持久化了，
 *      而临时视图写完就销毁 —— 不复查就分不清这两种情况。
 *
 * 结论由 debug_note 打到 stdout，和仓库里其余几条自检一致。
 */
(async () => {
  const tauri = window.__TAURI__.core;
  const note = (m) => tauri.invoke('debug_note', { line: m });
  const verdicts = [];

  try {
    // --- 第一程：导出 ---------------------------------------------------
    await note('① 导出（不弹对话框，走 AIHUB_LOGIN_EXPORT_TO）…');
    const t0 = Date.now();
    const out = await window.api.exportLogin('');
    const exportSecs = ((Date.now() - t0) / 1000).toFixed(1);

    if (!out || !out.ok) {
      await note(`导出失败（${exportSecs}s）：${(out && out.error) || '没有返回值'}`);
      verdicts.push('红：导出就没过去');
      return;
    }
    // 刻意只报数量，不报任何 cookie 名字或值
    await note(`   导出成功（${exportSecs}s）：${out.services} 个服务 / ${out.cookies} 条 Cookie `
      + `/ ${out.storages} 项本地存储 / 跳过 ${out.skipped} 项 / ${out.bytes} 字节`);
    verdicts.push(out.cookies > 0
      ? '绿：导出没死锁，且真的读到了 Cookie'
      : '黄：导出没死锁，但一条 Cookie 都没读到');

    // --- 第二程：预检（dryRun，不写任何东西）----------------------------
    await note('② 预检刚导出的那个文件…');
    const dry = await window.api.importLogin({ file: out.file, password: '', dryRun: true });
    if (!dry || !dry.ok) {
      await note(`   预检失败：${(dry && dry.error) || '没有返回值'}`);
      verdicts.push('红：自己导出的文件自己都认不出来');
      return;
    }
    const matched = (dry.services || []).length;
    await note(`   预检通过：匹配上 ${matched} 个服务，未匹配 ${(dry.unmatched || []).length} 个`);
    verdicts.push(matched === out.services
      ? '绿：导出几个服务就匹配回几个'
      : `红：导出 ${out.services} 个，只匹配回 ${matched} 个`);

    // --- 第三程：真写回 --------------------------------------------------
    await note('③ 真写回（set_cookie + 本地存储）…');
    const t1 = Date.now();
    const res = await window.api.importLogin({ file: out.file, password: '', dryRun: false });
    const importSecs = ((Date.now() - t1) / 1000).toFixed(1);
    if (!res || !res.ok) {
      await note(`   导入失败（${importSecs}s）：${(res && res.error) || '没有返回值'}`);
      verdicts.push('红：写回失败');
      return;
    }
    const wrote = res.services.reduce((n, s) => n + s.cookies, 0);
    const failed = res.services.reduce((n, s) => n + (s.failed || 0), 0);
    const stored = res.services.reduce((n, s) => n + s.storages, 0);
    await note(`   导入完成（${importSecs}s）：写回 ${wrote} 条 Cookie、${stored} 项本地存储，${failed} 条被拒`);
    for (const s of res.services) {
      await note(`     ${s.id}: cookie ${s.cookies} 成功 / ${s.failed || 0} 被拒，本地存储 ${s.storages}`);
    }
    verdicts.push(failed === 0 && wrote > 0
      ? '绿：WebView2 接受了全部写回'
      : `红：${failed} 条 Cookie 被拒（写回路径有问题）`);

    // --- 第四程：再导一次，确认写回**真的落盘**了 ------------------------
    //
    // ③ 只证明 set_cookie 返回了 Ok，不证明它持久化了：WebView2 的 cookie 写入
    // 是异步的，而临时视图写完就被销毁。不再读一遍就分不清「写进去了」和
    // 「调用成功但随视图一起没了」——那正是最难查的一类假绿。
    await note('④ 再导一次，看写回有没有真的落盘…');
    const again = await window.api.exportLogin('');
    if (!again || !again.ok) {
      await note(`   复查导出失败：${(again && again.error) || '没有返回值'}`);
      verdicts.push('红：复查导不出来');
      return;
    }
    await note(`   复查：${again.cookies} 条 Cookie（写回前是 ${out.cookies} 条）`);
    // 不要求一模一样：这一轮里站点自己也会种新 cookie、也可能有过期的被丢掉。
    // 盯的是「没有大面积丢失」。
    verdicts.push(again.cookies >= Math.floor(out.cookies * 0.9)
      ? '绿：写回确实落盘了'
      : `红：写回后只剩 ${again.cookies} 条，原本 ${out.cookies} 条 —— 没落盘`);
  } catch (err) {
    await note(`抛异常：${err && err.message ? err.message : err}`);
    verdicts.push('红：抛异常');
  } finally {
    for (const v of verdicts) await note(`判定 ${v}`);
    await note('自检结束，退出应用');
    window.api.quit();
  }
})();
