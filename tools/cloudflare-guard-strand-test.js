/**
 * Cloudflare 守卫的「别把用户丢在原始响应上」回归测试（Node + Chromium，不用构建 app）。
 *
 *   node tools/cloudflare-guard-strand-test.js
 *
 * 为什么另开一个回路：`tools/cloudflare-guard-loop.sh` 跑的是**真 app**，
 * 它验的是「挑战能不能被挪进文档里跑完」；而下面这些用例验的是守卫自己的
 * **状态机**——并发、状态掉落、连续失败。状态机的坑用真 app 复现太贵（每轮
 * 要起窗口、等 14 秒），而 WebView2 的内核就是 Chromium，拿 Chromium 直接
 * 注入同一份 challenge-guard.js 就够了，而且是确定性的。
 *
 * 已经验过的前提（否则下面整套「回到原页」都不成立）：application/json 文档
 * 上 document-start 注入脚本**照跑**、DOMContentLoaded **照触发**、
 * sessionStorage **带得过去**。三条在 Chromium 上都成立。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadChromium() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'playwright')).chromium;
  } catch {
    console.error('需要 playwright：npm install -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const GUARD = fs.readFileSync(path.join(__dirname, '..', 'src-ui', 'challenge-guard.js'), 'utf8');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title>'
  + '<script>window._cf_chl_opt={};</script></head><body>Just a moment</body></html>';

/**
 * fixture：/api/* 对 XHR 回 403 挑战，对**文档**导航回真业务 JSON
 * ——这就是 Cloudflare 过盾后重放原请求的样子，也正是「用户停在一坨 JSON 上」的现场。
 * `?hard=1` 的站点连文档导航都挑战，用来验「认输」这一档。
 */
function server() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, BASE);
    if (url.pathname.startsWith('/api/')) {
      const isDoc = req.headers['sec-fetch-dest'] === 'document';
      if (isDoc && !url.searchParams.has('hard')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ title: 'ChatGPT', models: [{ slug: 'gpt-5-5' }] }));
      }
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      return res.end(CHALLENGE_HTML);
    }
    const targets = (url.searchParams.get('hit') || '').split(',').filter(Boolean);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>App</title><body>APP PAGE<script>
      ${JSON.stringify(targets)}.forEach((t) => fetch(t).catch(() => {}));
    </script>`);
  });
}

const CASES = [
  {
    name: '单发挑战 → 回到原页',
    page: '/app?hit=/api/models',
    expect: (r) => r.url.includes('/app'),
  },
  {
    name: '同一 URL 并发两次挑战 → 仍然回到原页',
    page: '/app?hit=/api/models,/api/models',
    expect: (r) => r.url.includes('/app'),
  },
  {
    name: '两个不同 URL 同时被挑战 → 仍然回到原页',
    page: '/app?hit=/api/models,/api/conversations',
    expect: (r) => r.url.includes('/app'),
  },
  {
    name: '状态掉了一半（只剩 tried，没有 returns）→ 靠兜底回到原页',
    page: '/app',
    seed: (home, api) => ({ tried: { [api]: Date.now() }, home }),
    gotoAfterSeed: '/api/models',
    expect: (r) => r.url.includes('/app'),
  },
  {
    name: '一串接口接连被拦 → 总重放次数封顶，不把用户来回甩',
    page: '/app?hit=/api/a,/api/b,/api/c,/api/d,/api/e',
    expect: (r) => r.navigations <= 1 + 3 * 2,
  },
  {
    // 这一档不能要求「回到原页」：文档本身就是活的挑战页，把它打断等于登录必挂。
    // 要求的是别把人**闷死**在这儿 —— 必须有可点的返回口，且不许无限刷。
    name: '文档导航也过不了盾 → 只导航一次、挂可点的返回口、不无限刷',
    page: '/app?hit=/api/models%3Fhard=1',
    expect: (r) => r.banner && r.backBtn && r.navigations <= 3,
  },
];

(async () => {
  const chromium = loadChromium();
  const srv = server();
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  let failed = 0;

  for (const c of CASES) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(GUARD);
    const page = await ctx.newPage();
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations += 1; });

    await page.goto(BASE + c.page);
    if (c.seed) {
      const state = c.seed(BASE + c.page, BASE + '/api/models');
      await page.evaluate((s) => sessionStorage.setItem('aihub_cf_guard', JSON.stringify(s)), state);
      await page.goto(BASE + c.gotoAfterSeed);
    }
    await page.waitForTimeout(2500);

    const r = await page.evaluate(() => ({
      url: location.href,
      banner: !!document.getElementById('aihub-cf-guard-banner'),
      backBtn: !!document.querySelector('#aihub-cf-guard-banner button'),
    }));
    r.navigations = navigations;

    const ok = c.expect(r);
    if (!ok) failed += 1;
    console.log(`${ok ? '✅' : '❌'} ${c.name}`);
    console.log(`     落点 ${r.url}  提示条=${r.banner}  返回口=${r.backBtn}  导航次数=${r.navigations}`);
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
