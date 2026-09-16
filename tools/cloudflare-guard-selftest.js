/**
 * Cloudflare 挑战的回路自检脚本（Tauri debug 构建专用）。
 *
 * 通常不直接调它，用外面那个包裹：
 *
 *   bash tools/cloudflare-guard-loop.sh                     # 修复前：期望红
 *   CF_EXPECT=green bash tools/cloudflare-guard-loop.sh     # 修复后：期望绿
 *
 * 它的职责被刻意压到最小：**只负责把 fixture 站点挂到真 app 里、再还原**。
 * 所有的断言都不在这里——红绿由 fixture 服务器的轨迹判定（页面会把自己的渲染
 * 结果回传过去）。这么分是因为「观测」在这套工具链里有两条死路，记下来免得
 * 下一个人再踩：
 *
 *   1. 外壳 `fetch('http://127.0.0.1:.../__status')` → WebKit 给 `Load failed`
 *      （外壳 origin 是 `tauri://localhost`，跨 scheme 取 http 被拒）；
 *   2. 外壳里 `invoke('debug_eval', { target: <站点id> })` → **死锁**：内层
 *      eval 阻塞主线程等回调，而回调要回主线程派发，10 秒后超时。
 *
 * 所以：站点页面自己上报 → 服务器 stdout 出轨迹 → 包裹脚本读轨迹判红绿。
 * 这个脚本跑完要能在输出里看到「已挂上」和「已还原」两行。
 */
(async () => {
  const tauri = window.__TAURI__.core;
  const note = (m) => tauri.invoke('debug_note', { line: m });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const FIXTURE = 'http://127.0.0.1:8791/';
  /** 给「页面加载 → fetch 撞挑战 →（修复后）顶层导航 → 过盾 → 重试」留的整段窗口 */
  const SETTLE_MS = Number(14000);

  const beforePanes = (await window.api.getLayout()).panes.map((p) => p.id);
  let addedId = null;

  try {
    // 名字带时间戳：服务 id 唯一 → WebView 数据目录唯一 → 每轮都是干净 profile。
    // 不这么做会踩一次坑：守卫的「重试过没有」闸门写在 sessionStorage/cookie 里，
    // 上一轮的痕迹还在 60 秒窗口内，这一轮守卫就会照规矩停手，看起来像没修好。
    const added = await window.api.addService({
      name: `CF Fixture ${Date.now()}`, url: FIXTURE, color: '#8a8a8a', icon: '',
    });
    addedId = added.id;
    await window.api.setPanes([addedId]); // 真建一个站点 webview
    await note(`已挂上 fixture 站点 id=${addedId} url=${FIXTURE}，开始计时 ${SETTLE_MS}ms`);
    await wait(SETTLE_MS);
  } catch (err) {
    await note(`失败: 自检抛错 ${err && err.message ? err.message : err}`);
  } finally {
    try {
      if (addedId) await window.api.removeService(addedId, true); // 连 WebViews 目录一起清
      await window.api.setPanes(beforePanes);
      await note('已还原外壳状态（服务列表与分屏）');
    } catch (err) {
      await note(`还原失败（请手动检查服务列表）: ${err && err.message ? err.message : err}`);
    }
  }
})();
